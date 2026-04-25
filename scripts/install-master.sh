#!/usr/bin/env bash
set -euo pipefail

# ── Config ───────────────────────────────────────────────────────────────────
GITHUB_REPO="Beykus-Y/Admin_vps"
RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}/main"
INSTALL_DIR="/opt/filincontrol"
COMPOSE_FILE="${INSTALL_DIR}/docker-compose.yml"
CADDYFILE="${INSTALL_DIR}/caddy/Caddyfile"
ENV_FILE="${INSTALL_DIR}/.env"

RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[info]${NC}  $*"; }
ok()      { echo -e "${GREEN}[ ok ]${NC}  $*"; }
warn()    { echo -e "${YELLOW}[warn]${NC}  $*"; }
die()     { echo -e "${RED}[fail]${NC}  $*" >&2; exit 1; }

# ── Root check ───────────────────────────────────────────────────────────────
[[ "$EUID" -ne 0 ]] && die "Run as root: sudo bash install-master.sh"

echo ""
echo "  ██████╗ ██╗██╗     ██╗███╗   ██╗"
echo "  ██╔══╝  ██║██║     ██║████╗  ██║"
echo "  █████╗  ██║██║     ██║██╔██╗ ██║"
echo "  ██╔══╝  ██║██║     ██║██║╚██╗██║"
echo "  ██║     ██║███████╗██║██║ ╚████║"
echo "  ╚═╝     ╚═╝╚══════╝╚═╝╚═╝  ╚═══╝  Control"
echo ""
echo "  Master server installer"
echo "  ────────────────────────────────"
echo ""

# ── OS check ─────────────────────────────────────────────────────────────────
source /etc/os-release 2>/dev/null || die "Cannot detect OS"
info "OS: ${PRETTY_NAME}"

case "${ID}" in
  ubuntu|debian|linuxmint) : ;;
  *) warn "Untested OS: ${ID}. Proceeding anyway (may need manual adjustments)." ;;
esac

ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  *) die "Unsupported architecture: $ARCH" ;;
esac
info "Arch: $ARCH"

# ── Prompt: domain or IP ──────────────────────────────────────────────────────
echo ""
echo "  What domain or IP will the panel run on?"
echo "  Examples: panel.example.com  |  1.2.3.4"
echo ""
read -rp "  Domain/IP: " HOST
[[ -z "$HOST" ]] && die "Domain/IP is required"

# Detect whether HOST looks like an IP (no HTTPS) or a domain (HTTPS via Caddy)
USE_TLS=true
if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || [[ "$HOST" == "localhost" ]]; then
  USE_TLS=false
  warn "IP/localhost detected — Caddy will serve plain HTTP (no TLS)"
fi

# ── Prompt: admin credentials ─────────────────────────────────────────────────
echo ""
read -rp "  Admin username [admin]: " ADMIN_USER
ADMIN_USER="${ADMIN_USER:-admin}"

while true; do
  read -rsp "  Admin password: " ADMIN_PASS; echo ""
  [[ ${#ADMIN_PASS} -ge 8 ]] && break
  warn "Password must be at least 8 characters"
done

# ── Step 1: Install Docker ────────────────────────────────────────────────────
echo ""
info "[1/6] Checking Docker..."
if ! command -v docker &>/dev/null; then
  info "Docker not found — installing..."
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker
  ok "Docker installed"
else
  DOCKER_VER=$(docker --version | grep -oP '[\d.]+' | head -1)
  ok "Docker ${DOCKER_VER} already installed"
fi

# Check Docker Compose (plugin or standalone)
if docker compose version &>/dev/null 2>&1; then
  ok "Docker Compose plugin available"
elif command -v docker-compose &>/dev/null; then
  # Alias for scripts
  shopt -s expand_aliases
  alias "docker compose"="docker-compose"
  ok "docker-compose (standalone) available"
else
  info "Installing Docker Compose plugin..."
  apt-get install -y docker-compose-plugin 2>/dev/null || \
    die "Could not install docker-compose-plugin. Install it manually: https://docs.docker.com/compose/install/"
  ok "Docker Compose installed"
fi

# ── Step 2: Download files ────────────────────────────────────────────────────
info "[2/6] Downloading FilinControl files..."
mkdir -p "${INSTALL_DIR}/caddy"

curl -fsSL "${RAW_BASE}/deploy/docker-compose.prod.yml" -o "${COMPOSE_FILE}"
ok "docker-compose.yml downloaded"

# ── Step 3: Generate config ───────────────────────────────────────────────────
info "[3/6] Generating configuration..."

JWT_SECRET=$(openssl rand -hex 32)
PANEL_URL="${HOST}"

cat > "${ENV_FILE}" <<EOF
JWT_SECRET=${JWT_SECRET}
EOF
chmod 600 "${ENV_FILE}"
ok ".env created (JWT_SECRET generated)"

# Write Caddyfile
if [[ "$USE_TLS" == true ]]; then
  cat > "${CADDYFILE}" <<EOF
${HOST} {
    reverse_proxy /api/* api:8000
    reverse_proxy web:3000
}
EOF
  ok "Caddyfile: HTTPS for ${HOST}"
else
  cat > "${CADDYFILE}" <<EOF
:80 {
    reverse_proxy /api/* api:8000
    reverse_proxy web:3000
}
EOF
  ok "Caddyfile: HTTP on port 80"
fi

# ── Step 4: Pull images ───────────────────────────────────────────────────────
info "[4/6] Pulling Docker images..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" pull
ok "Images pulled"

# ── Step 5: Run migrations ────────────────────────────────────────────────────
info "[5/6] Running database migrations..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" run --rm migrate
ok "Migrations complete"

# ── Step 6: Start services ────────────────────────────────────────────────────
info "[6/6] Starting services..."
docker compose -f "${COMPOSE_FILE}" --env-file "${ENV_FILE}" up -d --remove-orphans
ok "Services started"

# ── Wait for API to be ready ──────────────────────────────────────────────────
info "Waiting for API to be ready..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:8000/health &>/dev/null; then
    ok "API is up"
    break
  fi
  if [[ $i -eq 30 ]]; then
    warn "API did not respond in time — continuing anyway"
  fi
  sleep 2
done

# ── Create admin user ─────────────────────────────────────────────────────────
info "Creating admin user '${ADMIN_USER}'..."
HTTP_STATUS=$(curl -s -o /tmp/fc_init_resp.json -w "%{http_code}" \
  -X POST http://localhost:8000/api/auth/init \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${ADMIN_USER}\",\"password\":\"${ADMIN_PASS}\"}")

if [[ "$HTTP_STATUS" == "200" ]]; then
  ok "Admin user created"
elif [[ "$HTTP_STATUS" == "403" ]]; then
  warn "Admin already exists — skipping user creation"
else
  warn "Unexpected response ${HTTP_STATUS}: $(cat /tmp/fc_init_resp.json)"
fi
rm -f /tmp/fc_init_resp.json

# ── Create systemd service for auto-start ────────────────────────────────────
cat > /etc/systemd/system/filincontrol.service <<EOF
[Unit]
Description=FilinControl Master
After=docker.service network-online.target
Requires=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=${INSTALL_DIR}
ExecStart=/usr/bin/docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} up -d --remove-orphans
ExecStop=/usr/bin/docker compose -f ${COMPOSE_FILE} --env-file ${ENV_FILE} down
TimeoutStartSec=120

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable filincontrol
ok "filincontrol.service enabled (auto-start on reboot)"

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo "  ────────────────────────────────────────────────────"
ok "FilinControl installed successfully!"
echo ""
if [[ "$USE_TLS" == true ]]; then
  echo "  Panel URL : https://${HOST}"
else
  echo "  Panel URL : http://${HOST}"
fi
echo "  Username  : ${ADMIN_USER}"
echo "  Install dir: ${INSTALL_DIR}"
echo ""
echo "  Useful commands:"
echo "    docker compose -f ${COMPOSE_FILE} ps"
echo "    docker compose -f ${COMPOSE_FILE} logs -f api"
echo "    systemctl restart filincontrol"
echo ""
if [[ "$USE_TLS" == true ]]; then
  echo "  ${YELLOW}Make sure your DNS A-record for ${HOST} points to this server${NC}"
  echo "  ${YELLOW}Caddy will issue a Let's Encrypt certificate automatically.${NC}"
fi
echo "  ────────────────────────────────────────────────────"
echo ""
