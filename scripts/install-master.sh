#!/usr/bin/env bash
set -euo pipefail

# ── Constants ─────────────────────────────────────────────────────────────────
INSTALLER_VERSION="0.2.0"
GITHUB_REPO="Beykus-Y/Admin_vps"
RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}/main"
INSTALL_DIR="/opt/filincontrol"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
COMPOSE_OVERRIDE=""
CADDYFILE="${INSTALL_DIR}/caddy/Caddyfile"
ENV_FILE="${INSTALL_DIR}/.env"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
info()  { echo -e "${CYAN}[info]${NC}  $*"; }
ok()    { echo -e "${GREEN}[ ok ]${NC}  $*"; }
warn()  { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()   { echo -e "${RED}[fail]${NC}  $*" >&2; exit 1; }
bold()  { echo -e "${BOLD}$*${NC}"; }

# ── Root check ────────────────────────────────────────────────────────────────
[[ "$EUID" -ne 0 ]] && die "Run as root: sudo bash install-master.sh"

echo ""
bold "  FilinControl — Master Server Installer v${INSTALLER_VERSION}"
echo "  ────────────────────────────────────────────────────────"
echo ""

# ── OS / Arch ─────────────────────────────────────────────────────────────────
source /etc/os-release 2>/dev/null || die "Cannot detect OS (/etc/os-release missing)"
info "OS: ${PRETTY_NAME}"
case "${ID}" in
  ubuntu|debian|linuxmint) PKG_MGR="apt-get" ;;
  centos|rhel|fedora|rocky|almalinux) PKG_MGR="yum" ;;
  *) PKG_MGR="apt-get"; warn "Untested OS '${ID}' — assuming apt-get" ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH_SLUG="amd64" ;;
  aarch64) ARCH_SLUG="arm64" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac
info "Arch: $ARCH_SLUG"

# ── Detect existing reverse proxy ─────────────────────────────────────────────
# Returns the process name that holds port 80 or 443, or empty string
detect_proxy() {
  local port="${1:-80}"
  ss -tlnp 2>/dev/null | awk -v p=":${port} " '$0 ~ p {print $NF}' | \
    grep -oP 'pid=\K[0-9]+' | head -1 | xargs -I{} cat /proc/{}/comm 2>/dev/null || true
}

PROXY_ON_80=$(detect_proxy 80)
PROXY_ON_443=$(detect_proxy 443)
PROXY_PROC="${PROXY_ON_80:-${PROXY_ON_443:-}}"

USE_CADDY_CONTAINER=true
EXTERNAL_PROXY=""

if [[ -n "$PROXY_PROC" ]]; then
  case "$PROXY_PROC" in
    caddy)   EXTERNAL_PROXY="caddy"   ;;
    nginx)   EXTERNAL_PROXY="nginx"   ;;
    apache2|httpd) EXTERNAL_PROXY="apache" ;;
    *)       EXTERNAL_PROXY="other:${PROXY_PROC}" ;;
  esac
  USE_CADDY_CONTAINER=false
  warn "Port 80/443 is already used by: ${BOLD}${PROXY_PROC}${NC}"
  warn "Caddy container will be skipped — you'll configure ${PROXY_PROC} manually."
else
  ok "Ports 80/443 are free — will use Caddy container"
fi

# ── Prompts ───────────────────────────────────────────────────────────────────
# Redirect individual reads from /dev/tty so prompts work when piped via curl|bash
# (exec < /dev/tty would break bash's own script reading from the pipe)

echo ""
echo "  What domain or IP will the panel run on?"
echo "  Examples: panel.example.com  |  1.2.3.4  |  localhost"
echo ""
read -rp "  Domain/IP: " HOST </dev/tty
[[ -z "$HOST" ]] && die "Domain/IP is required"

# IP/localhost → no TLS
USE_TLS=true
if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ "$HOST" == "localhost" ]]; then
  USE_TLS=false
fi

echo ""
read -rp "  Admin username [admin]: " ADMIN_USER </dev/tty
ADMIN_USER="${ADMIN_USER:-admin}"

while true; do
  read -rsp "  Admin password (min 8 chars): " ADMIN_PASS </dev/tty; echo ""
  [[ ${#ADMIN_PASS} -ge 8 ]] && break
  warn "Password must be at least 8 characters"
done

echo ""

# ── Step 1: Docker ────────────────────────────────────────────────────────────
info "[1/6] Checking Docker..."
if ! command -v docker &>/dev/null; then
  info "Docker not found — installing via get.docker.com..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "Docker installed"
else
  ok "Docker $(docker --version | grep -oP '[\d.]+' | head -1) already installed"
fi

if ! docker compose version &>/dev/null 2>&1; then
  info "Installing docker-compose-plugin..."
  if ! ${PKG_MGR} install -y docker-compose-plugin 2>/dev/null; then
    info "Package install failed — downloading Docker Compose binary directly..."
    COMPOSE_VER=$(curl -sfI https://github.com/docker/compose/releases/latest | \
      grep -i '^location:' | grep -oP 'v[\d.]+' | head -1)
    [[ -z "$COMPOSE_VER" ]] && COMPOSE_VER="v2.27.1"
    mkdir -p /usr/local/lib/docker/cli-plugins
    curl -fsSL "https://github.com/docker/compose/releases/download/${COMPOSE_VER}/docker-compose-linux-${ARCH}" \
      -o /usr/local/lib/docker/cli-plugins/docker-compose
    chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
    docker compose version &>/dev/null 2>&1 || \
      die "Could not install Docker Compose. See https://docs.docker.com/compose/install/"
  fi
fi
ok "Docker Compose available"

# ── Step 2: Create install dir + download files ───────────────────────────────
info "[2/6] Setting up ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}/caddy"
curl -fsSL "${RAW_BASE}/deploy/docker-compose.prod.yml" -o "${COMPOSE_FILE}"
ok "docker-compose.yml → ${COMPOSE_FILE}"

# ── Step 3: Config ────────────────────────────────────────────────────────────
info "[3/6] Generating configuration..."
JWT_SECRET=$(openssl rand -hex 32)
cat > "${ENV_FILE}" <<EOF
JWT_SECRET=${JWT_SECRET}
EOF
chmod 600 "${ENV_FILE}"
ok "JWT_SECRET generated → ${ENV_FILE}"

# Write Compose override depending on proxy situation
if [[ "$USE_CADDY_CONTAINER" == true ]]; then
  # Build Caddyfile
  if [[ "$USE_TLS" == true ]]; then
    cat > "${CADDYFILE}" <<EOF
${HOST} {
    reverse_proxy /api/* api:8000
    reverse_proxy web:3000
}
EOF
  else
    cat > "${CADDYFILE}" <<EOF
:80 {
    reverse_proxy /api/* api:8000
    reverse_proxy web:3000
}
EOF
  fi
  ok "Caddyfile written ($([ "$USE_TLS" == true ] && echo "HTTPS" || echo "HTTP"))"
else
  # External proxy: expose API (8000) and web (3000) on localhost and disable caddy container
  COMPOSE_OVERRIDE="${INSTALL_DIR}/docker-compose.override.yml"
  cat > "${COMPOSE_OVERRIDE}" <<EOF
# Auto-generated: external proxy detected (${PROXY_PROC})
# Exposes API and web ports to host, disables Caddy container.
services:
  api:
    ports:
      - "127.0.0.1:8000:8000"
  web:
    ports:
      - "127.0.0.1:3000:3000"
  caddy:
    profiles:
      - disabled
EOF
  ok "Compose override written (caddy disabled, ports 8000/3000 exposed on 127.0.0.1)"
fi

# ── Build compose args (file-existence check, safe for empty COMPOSE_OVERRIDE) ─
DC=(docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}")
[[ -n "${COMPOSE_OVERRIDE}" && -f "${COMPOSE_OVERRIDE}" ]] && DC+=(-f "${COMPOSE_OVERRIDE}")

# ── Step 4: Pull images ───────────────────────────────────────────────────────
info "[4/6] Pulling Docker images..."
"${DC[@]}" pull
ok "Images pulled"

# ── Step 5: Migrations ────────────────────────────────────────────────────────
info "[5/6] Running database migrations..."
"${DC[@]}" run --rm migrate
ok "Migrations complete"

# ── Step 6: Start ─────────────────────────────────────────────────────────────
info "[6/6] Starting services..."
"${DC[@]}" up -d --remove-orphans
ok "Services started"

# ── Wait for API ──────────────────────────────────────────────────────────────
info "Waiting for API..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/health &>/dev/null; then
    ok "API is up"; break
  fi
  [[ $i -eq 30 ]] && { warn "API slow to start — continuing anyway"; break; }
  sleep 2
done

# ── Create admin user ─────────────────────────────────────────────────────────
info "Creating admin user '${ADMIN_USER}'..."
HTTP_STATUS=$(curl -s -o /tmp/fc_init.json -w "%{http_code}" \
  -X POST http://localhost:8000/api/auth/init \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")

case "$HTTP_STATUS" in
  200) ok "Admin user '${ADMIN_USER}' created" ;;
  403) warn "Admin already exists — skipping" ;;
  *)   warn "Unexpected response ${HTTP_STATUS}: $(cat /tmp/fc_init.json 2>/dev/null)" ;;
esac
rm -f /tmp/fc_init.json

# ── systemd service ───────────────────────────────────────────────────────────
COMPOSE_CMD="docker compose -f ${COMPOSE_FILE}"
[[ -f "${COMPOSE_OVERRIDE}" ]] && COMPOSE_CMD+=" -f ${COMPOSE_OVERRIDE}"
COMPOSE_CMD+=" --env-file ${ENV_FILE}"

cat > /etc/systemd/system/filincontrol.service <<EOF
[Unit]
Description=FilinControl Master
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/${COMPOSE_CMD} up -d --remove-orphans
ExecStop=/usr/bin/${COMPOSE_CMD} down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable filincontrol
ok "filincontrol.service enabled (auto-start on reboot)"

# ── Show external proxy config snippet ───────────────────────────────────────
if [[ "$USE_CADDY_CONTAINER" == false ]]; then
  echo ""
  bold "  ╔══ Manual proxy config required ══════════════════════╗"

  if [[ "$EXTERNAL_PROXY" == "nginx" ]]; then
    echo ""
    bold "  Add to your Nginx config (/etc/nginx/sites-available/filincontrol):"
    echo ""
    if [[ "$USE_TLS" == true ]]; then
      cat <<EOF
    server {
        listen 80;
        server_name ${HOST};
        return 301 https://\$host\$request_uri;
    }
    server {
        listen 443 ssl;
        server_name ${HOST};
        # ssl_certificate / ssl_certificate_key — configure certbot separately

        location /api/ {
            proxy_pass         http://127.0.0.1:8000;
            proxy_set_header   Host \$host;
            proxy_set_header   X-Real-IP \$remote_addr;
            proxy_set_header   X-Forwarded-For \$proxy_add_x_forwarded_for;
            proxy_set_header   X-Forwarded-Proto \$scheme;
        }
        location / {
            proxy_pass         http://127.0.0.1:3000;
            proxy_set_header   Host \$host;
            proxy_set_header   X-Real-IP \$remote_addr;
        }
    }
EOF
    else
      cat <<EOF
    server {
        listen 80;
        server_name ${HOST};

        location /api/ {
            proxy_pass       http://127.0.0.1:8000;
            proxy_set_header Host \$host;
        }
        location / {
            proxy_pass       http://127.0.0.1:3000;
            proxy_set_header Host \$host;
        }
    }
EOF
    fi
    echo ""
    echo "  Then: nginx -t && systemctl reload nginx"

  elif [[ "$EXTERNAL_PROXY" == "caddy" ]]; then
    echo ""
    bold "  Add to your Caddyfile (/etc/caddy/Caddyfile):"
    echo ""
    if [[ "$USE_TLS" == true ]]; then
      cat <<EOF
    ${HOST} {
        reverse_proxy /api/* localhost:8000
        reverse_proxy localhost:3000
    }
EOF
    else
      cat <<EOF
    :80 {
        reverse_proxy /api/* localhost:8000
        reverse_proxy localhost:3000
    }
EOF
    fi
    echo ""
    echo "  Then: systemctl reload caddy"

  else
    warn "Unknown proxy '${PROXY_PROC}'. Manually proxy:"
    echo "    /api/*  → http://127.0.0.1:8000"
    echo "    /*      → http://127.0.0.1:3000"
  fi

  bold "  ╚═══════════════════════════════════════════════════════╝"
fi

# ── Summary ───────────────────────────────────────────────────────────────────
echo ""
bold "  ══════════════════════════════════════════════"
ok "FilinControl installed!"
echo ""
if [[ "$USE_CADDY_CONTAINER" == true ]]; then
  if [[ "$USE_TLS" == true ]]; then
    echo "  Panel URL  : https://${HOST}"
    warn "Ensure DNS A-record for ${HOST} points here — Caddy issues TLS automatically"
  else
    echo "  Panel URL  : http://${HOST}"
  fi
else
  echo "  API port   : http://127.0.0.1:8000  (proxy this)"
  echo "  Web port   : http://127.0.0.1:3000  (proxy this)"
  echo "  Panel URL  : $([ "$USE_TLS" == true ] && echo "https" || echo "http")://${HOST}  (after proxy config)"
fi
echo "  Username   : ${ADMIN_USER}"
echo "  Install dir: ${INSTALL_DIR}"
echo ""
echo "  Useful commands:"
echo "    docker compose -f ${COMPOSE_FILE} ps"
echo "    docker compose -f ${COMPOSE_FILE} logs -f api"
echo "    systemctl restart filincontrol"
bold "  ══════════════════════════════════════════════"
echo ""
