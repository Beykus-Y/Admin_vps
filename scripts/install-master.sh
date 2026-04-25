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
OWN_CADDY_CONTAINER=false

if [[ -n "$PROXY_PROC" ]] && command -v docker &>/dev/null; then
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -qx 'filincontrol-caddy-1'; then
    OWN_CADDY_CONTAINER=true
  fi
fi

USE_CADDY_CONTAINER=true
EXTERNAL_PROXY=""

if [[ "$OWN_CADDY_CONTAINER" == true ]]; then
  ok "Ports 80/443 are used by existing FilinControl Caddy container — will reuse it"
elif [[ -n "$PROXY_PROC" ]]; then
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
# Strip http(s):// prefix and trailing slashes
HOST="${HOST#http://}"; HOST="${HOST#https://}"; HOST="${HOST%%/*}"
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
DOCKER_BIN="$(command -v docker)"

# ── Step 2: Create install dir + download files ───────────────────────────────
info "[2/6] Setting up ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}/caddy"
curl -fsSL "${RAW_BASE}/deploy/docker-compose.prod.yml" -o "${COMPOSE_FILE}"
ok "docker-compose.yml → ${COMPOSE_FILE}"

# ── Step 3: Config ────────────────────────────────────────────────────────────
info "[3/6] Generating configuration..."
EXISTING_JWT_SECRET=""
if [[ -f "${ENV_FILE}" ]]; then
  EXISTING_JWT_SECRET="$(grep '^JWT_SECRET=' "${ENV_FILE}" | head -1 | cut -d= -f2- || true)"
fi

if [[ -n "${EXISTING_JWT_SECRET}" ]]; then
  JWT_SECRET="${EXISTING_JWT_SECRET}"
  ok "Existing JWT_SECRET reused → ${ENV_FILE}"
else
  JWT_SECRET=$(openssl rand -hex 32)
  if [[ -f "${ENV_FILE}" ]]; then
    printf '\nJWT_SECRET=%s\n' "${JWT_SECRET}" >> "${ENV_FILE}"
  else
    cat > "${ENV_FILE}" <<EOF
JWT_SECRET=${JWT_SECRET}
EOF
  fi
  ok "JWT_SECRET generated → ${ENV_FILE}"
fi
chmod 600 "${ENV_FILE}"

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
if ! "${DC[@]}" run --rm -T migrate </dev/null; then
  warn "Migration container failed — retrying once..."
  "${DC[@]}" run --rm -T migrate </dev/null || die "Database migrations failed — run: ${DC[*]} logs postgres"
fi
ok "Migrations complete"

# ── Step 6: Start ─────────────────────────────────────────────────────────────
info "[6/6] Starting services..."
"${DC[@]}" up -d --remove-orphans || die "docker compose up failed — run: ${DC[*]} logs"
ok "Services started"

# ── Wait for API ──────────────────────────────────────────────────────────────
info "Waiting for API..."
api_healthcheck() {
  "${DC[@]}" exec -T api python -c 'import urllib.request; urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2).read()' </dev/null >/dev/null 2>&1
}

API_READY=false
for i in $(seq 1 60); do
  if api_healthcheck; then
    API_READY=true
    ok "API is up"
    break
  fi
  sleep 2
done
[[ "${API_READY}" == true ]] || die "API did not become healthy — run: ${DC[*]} logs api"

# ── Create admin user ─────────────────────────────────────────────────────────
info "Creating admin user '${ADMIN_USER}'..."
init_admin_http() {
  "${DC[@]}" exec -T \
  -e FC_ADMIN_USER="${ADMIN_USER}" \
  -e FC_ADMIN_PASS="${ADMIN_PASS}" \
  api python -c '
import json
import os
import sys
import urllib.error
import urllib.request

payload = json.dumps({
    "username": os.environ["FC_ADMIN_USER"],
    "password": os.environ["FC_ADMIN_PASS"],
}).encode("utf-8")
request = urllib.request.Request(
    "http://127.0.0.1:8000/api/auth/init",
    data=payload,
    headers={"Content-Type": "application/json"},
    method="POST",
)

try:
    with urllib.request.urlopen(request, timeout=10) as response:
        print(response.status)
        print(response.read().decode("utf-8", "replace"))
except urllib.error.HTTPError as exc:
    print(exc.code)
    print(exc.read().decode("utf-8", "replace"))
except Exception as exc:
    print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
    sys.exit(2)
' </dev/null
}

init_admin_direct() {
  "${DC[@]}" exec -T \
  -e FC_ADMIN_USER="${ADMIN_USER}" \
  -e FC_ADMIN_PASS="${ADMIN_PASS}" \
  api python -c '
import asyncio
import json
import os
import sys
import traceback
import uuid

import bcrypt
from sqlalchemy import select

from app.db.base import AsyncSessionLocal
from app.db.models import User


async def main() -> None:
    async with AsyncSessionLocal() as db:
        result = await db.execute(select(User.id).limit(1))
        if result.scalar_one_or_none() is not None:
            print(403)
            print(json.dumps({"detail": "Admin already exists"}))
            return

        password_hash = bcrypt.hashpw(
            os.environ["FC_ADMIN_PASS"].encode("utf-8"),
            bcrypt.gensalt(),
        ).decode("utf-8")
        db.add(User(
            id=uuid.uuid4(),
            username=os.environ["FC_ADMIN_USER"],
            password_hash=password_hash,
            is_active=True,
        ))
        await db.commit()
        print(200)
        print(json.dumps({"detail": "Admin user created"}))


try:
    asyncio.run(main())
except Exception:
    traceback.print_exc(file=sys.stderr)
    sys.exit(2)
' </dev/null
}

set +e
INIT_RESPONSE="$(init_admin_http 2>&1)"
_INIT_EXIT=$?
set -e

if [[ $_INIT_EXIT -ne 0 ]]; then
  warn "HTTP admin init failed — falling back to direct database bootstrap"
  set +e
  INIT_RESPONSE="$(init_admin_direct 2>&1)"
  _INIT_EXIT=$?
  set -e
fi

[[ $_INIT_EXIT -eq 0 ]] || die "Could not create admin user: ${INIT_RESPONSE}"
HTTP_STATUS="$(printf '%s\n' "${INIT_RESPONSE}" | sed -n '1p')"
HTTP_BODY="$(printf '%s\n' "${INIT_RESPONSE}" | sed '1d')"

if [[ "$HTTP_STATUS" == "500" ]]; then
  warn "HTTP admin init returned 500 — falling back to direct database bootstrap"
  set +e
  INIT_RESPONSE="$(init_admin_direct 2>&1)"
  _INIT_EXIT=$?
  set -e
  [[ $_INIT_EXIT -eq 0 ]] || die "Could not create admin user: ${INIT_RESPONSE}"
  HTTP_STATUS="$(printf '%s\n' "${INIT_RESPONSE}" | sed -n '1p')"
  HTTP_BODY="$(printf '%s\n' "${INIT_RESPONSE}" | sed '1d')"
fi

case "$HTTP_STATUS" in
  200) ok "Admin user '${ADMIN_USER}' created" ;;
  403) warn "Admin already exists — skipping" ;;
  *)   die "Unexpected admin init response ${HTTP_STATUS}: ${HTTP_BODY}" ;;
esac

# ── systemd service ───────────────────────────────────────────────────────────
COMPOSE_CMD="${DOCKER_BIN} compose -f ${COMPOSE_FILE}"
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
ExecStart=${COMPOSE_CMD} up -d --remove-orphans
ExecStop=${COMPOSE_CMD} down
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
