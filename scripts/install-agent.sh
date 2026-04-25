#!/usr/bin/env bash
set -euo pipefail

MASTER_URL=""
ENROLL_TOKEN=""
CONFIG_DIR="/etc/filin-agent"
BINARY="/usr/local/bin/filin-agent"
GITHUB_REPO="Beykus-Y/Admin_vps"
GITHUB_API="https://api.github.com/repos/${GITHUB_REPO}/releases/latest"
SOURCE_TARBALL_URL="https://github.com/${GITHUB_REPO}/archive/refs/heads/main.tar.gz"

usage() {
  echo "Usage: $0 --master-url <url> --enroll-token <token> [--version <v0.x.x>]"
  exit 1
}

strip_spaces() {
  printf '%s' "${1:-}" | tr -d '[:space:]'
}

json_value() {
  local key="$1"
  python3 -c '
import json
import sys

key = sys.argv[1]
data = json.load(sys.stdin)
value = data.get(key, "")
if value is not None:
    print(value)
' "$key"
}

json_asset_url() {
  local asset_name="$1"
  python3 -c '
import json
import sys

asset_name = sys.argv[1]
data = json.load(sys.stdin)
for asset in data.get("assets", []):
    if asset.get("name") == asset_name:
        print(asset.get("browser_download_url", ""))
        break
' "$asset_name"
}

go_version_ok() {
  command -v go &>/dev/null || return 1
  local version major minor rest
  version="$(go env GOVERSION 2>/dev/null || true)"
  version="${version#go}"
  major="${version%%.*}"
  rest="${version#*.}"
  minor="${rest%%.*}"
  [[ "$major" =~ ^[0-9]+$ && "$minor" =~ ^[0-9]+$ ]] || return 1
  (( major > 1 || (major == 1 && minor >= 22) ))
}

build_from_source() {
  local output="$1"
  local tmpdir source_dir
  tmpdir="$(mktemp -d)"

  echo "[4/7] Downloading source from main..."
  curl -fsSL "$SOURCE_TARBALL_URL" -o "${tmpdir}/source.tar.gz"
  tar -xzf "${tmpdir}/source.tar.gz" -C "$tmpdir"
  source_dir="$(find "$tmpdir" -maxdepth 1 -mindepth 1 -type d -name 'Admin_vps-*' | head -1)"
  if [[ -z "$source_dir" || ! -d "${source_dir}/apps/agent" ]]; then
    rm -rf "$tmpdir"
    echo "Error: could not find agent source in repository archive"
    exit 1
  fi

  if go_version_ok; then
    echo "[4/7] Building agent with local Go..."
    (
      cd "${source_dir}/apps/agent"
      CGO_ENABLED=0 GOOS=linux GOARCH="$ARCH" \
        go build -ldflags="-s -w -X main.version=main" -o "$output" ./cmd/agent
    )
  elif command -v docker &>/dev/null; then
    echo "[4/7] Building agent with Docker golang:1.23-alpine..."
    mkdir -p "${tmpdir}/out"
    docker run --rm \
      -v "${source_dir}/apps/agent:/src" \
      -v "${tmpdir}/out:/out" \
      -w /src \
      -e GOOS=linux \
      -e GOARCH="$ARCH" \
      -e CGO_ENABLED=0 \
      golang:1.23-alpine \
      sh -c 'go build -ldflags="-s -w -X main.version=main" -o /out/filin-agent ./cmd/agent' </dev/null
    mv "${tmpdir}/out/filin-agent" "$output"
  else
    rm -rf "$tmpdir"
    echo "Error: no agent release is published and source build needs Go 1.22+ or Docker"
    echo "  Publish an agent release or install Docker on this node, then rerun this installer."
    exit 1
  fi

  rm -rf "$tmpdir"
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
MASTER_URL="${MASTER_URL%/}"
ENROLL_TOKEN="$(strip_spaces "$ENROLL_TOKEN")"
VERSION="$(strip_spaces "$VERSION")"

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
  RELEASE_API="https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${RELEASE_TAG//\//%2F}"
else
  RELEASE_API="$GITHUB_API"
fi

echo "[3/7] Fetching release info from GitHub..."
if ! command -v python3 &>/dev/null; then
  echo "Error: python3 is required to parse GitHub release metadata"
  exit 1
fi

if ! RELEASE_JSON=$(curl -fsSL \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  "$RELEASE_API" 2>/dev/null); then
  echo "[3/7] No published agent release found — will build from source"
  RELEASE_JSON=""
  DOWNLOAD_URL=""
  CHECKSUM_URL=""
  RELEASE_TAG_NAME="main"
else
  DOWNLOAD_URL=$(printf '%s' "$RELEASE_JSON" | json_asset_url "$BINARY_NAME")
  CHECKSUM_URL=$(printf '%s' "$RELEASE_JSON" | json_asset_url "$CHECKSUM_NAME")
  RELEASE_TAG_NAME=$(printf '%s' "$RELEASE_JSON" | json_value tag_name)
fi

# ── Download ─────────────────────────────────────────────────────────────
TMP=$(mktemp)

if [[ -n "$DOWNLOAD_URL" ]]; then
  echo "[3/7] Release: ${RELEASE_TAG_NAME}"
  echo "[4/7] Downloading ${BINARY_NAME}..."
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
else
  [[ -n "$RELEASE_TAG_NAME" ]] || RELEASE_TAG_NAME="main"
  echo "[3/7] Release asset '${BINARY_NAME}' unavailable — source build fallback"
  build_from_source "$TMP"
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
