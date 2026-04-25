#!/usr/bin/env bash
set -euo pipefail

MASTER_URL=""
ENROLL_TOKEN=""
CONFIG_DIR="/etc/filin-agent"
BINARY="/usr/local/bin/filin-agent"
GITHUB_REPO="Beykus-Y/Admin_vps"
GITHUB_API="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"

usage() {
  echo "Usage: $0 --master-url <url> --enroll-token <token> [--version <v0.x.x>]"
  exit 1
}

VERSION=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --master-url)    MASTER_URL="$2";    shift 2 ;;
    --enroll-token)  ENROLL_TOKEN="$2";  shift 2 ;;
    --version)       VERSION="$2";       shift 2 ;;
    *) echo "Unknown arg: $1"; usage ;;
  esac
done

[[ -z "$MASTER_URL" || -z "$ENROLL_TOKEN" ]] && usage

echo "┌─────────────────────────────┐"
echo "│   FilinControl Agent Setup  │"
echo "└─────────────────────────────┘"

# ── Root check ──────────────────────────────────────────────────────────
if [[ "$EUID" -ne 0 ]]; then
  echo "Error: run as root (sudo bash)"
  exit 1
fi

# ── OS check ────────────────────────────────────────────────────────────
if [[ ! -f /etc/os-release ]]; then
  echo "Error: unsupported OS (no /etc/os-release)"
  exit 1
fi
source /etc/os-release
echo "[1/7] OS: ${PRETTY_NAME:-Linux}"

# ── Arch detection ──────────────────────────────────────────────────────
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARCH="amd64" ;;
  aarch64) ARCH="arm64" ;;
  *) echo "Error: unsupported architecture: $ARCH"; exit 1 ;;
esac
echo "[2/7] Architecture: $ARCH"

# ── Systemd check ───────────────────────────────────────────────────────
if ! command -v systemctl &>/dev/null; then
  echo "Error: systemd is required"
  exit 1
fi

# ── Resolve download URL ────────────────────────────────────────────────
BINARY_NAME="filin-agent-linux-${ARCH}"
CHECKSUM_NAME="filin-agent-linux-${ARCH}.sha256"

if [[ -n "$VERSION" ]]; then
  RELEASE_TAG="agent/${VERSION}"
  RELEASE_API="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${RELEASE_TAG}"
else
  RELEASE_API="$GITHUB_API"
fi

echo "[3/7] Fetching release info from GitHub..."
RELEASE_JSON=$(curl -fsSL -H "Accept: application/vnd.github+json" "$RELEASE_API")
DOWNLOAD_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url":\s*"\K[^"]+'"${BINARY_NAME}"'(?=")' | head -1)
CHECKSUM_URL=$(echo "$RELEASE_JSON" | grep -oP '"browser_download_url":\s*"\K[^"]+'"${CHECKSUM_NAME}"'(?=")' | head -1)
RELEASE_TAG_NAME=$(echo "$RELEASE_JSON" | grep -oP '"tag_name":\s*"\K[^"]+' | head -1)

if [[ -z "$DOWNLOAD_URL" ]]; then
  echo "Error: could not find release asset '${BINARY_NAME}' in GitHub release '${RELEASE_TAG_NAME}'"
  echo "  Make sure you have published a release via the 'agent-release' workflow."
  exit 1
fi
echo "[3/7] Release: ${RELEASE_TAG_NAME}"

# ── Download ─────────────────────────────────────────────────────────────
echo "[4/7] Downloading ${BINARY_NAME}..."
TMP=$(mktemp)
curl -fsSL "$DOWNLOAD_URL" -o "$TMP"

# ── Verify checksum ──────────────────────────────────────────────────────
if [[ -n "$CHECKSUM_URL" ]]; then
  echo "[4/7] Verifying checksum..."
  EXPECTED=$(curl -fsSL "$CHECKSUM_URL" | awk '{print $1}')
  ACTUAL=$(sha256sum "$TMP" | awk '{print $1}')
  if [[ "$EXPECTED" != "$ACTUAL" ]]; then
    echo "Error: checksum mismatch!"
    echo "  Expected: $EXPECTED"
    echo "  Actual:   $ACTUAL"
    rm -f "$TMP"
    exit 1
  fi
  echo "[4/7] Checksum OK"
fi

chmod +x "$TMP"
mv "$TMP" "$BINARY"
echo "[5/7] Binary installed to $BINARY"

# ── Create config dir ────────────────────────────────────────────────────
mkdir -p "$CONFIG_DIR"

# ── Enroll ───────────────────────────────────────────────────────────────
echo "[6/7] Enrolling with master at ${MASTER_URL}..."
"$BINARY" --master-url "$MASTER_URL" --enroll-token "$ENROLL_TOKEN" --config "$CONFIG_DIR/config.yml"

# ── Systemd unit ─────────────────────────────────────────────────────────
cat > /etc/systemd/system/filin-agent.service <<EOF
[Unit]
Description=Filin Agent
After=network-online.target docker.service
Wants=network-online.target

[Service]
ExecStart=$BINARY --config $CONFIG_DIR/config.yml
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable filin-agent
systemctl start filin-agent

echo "[7/7] Service started"
echo ""
echo "┌────────────────────────────────────────────┐"
echo "│  FilinControl Agent installed successfully  │"
echo "│  Status: $(systemctl is-active filin-agent)                              │"
echo "│  Version: ${RELEASE_TAG_NAME}                          │"
echo "└────────────────────────────────────────────┘"
