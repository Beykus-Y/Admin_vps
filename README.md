# FilinControl

VPS infrastructure management panel. One panel — all your servers.

## Install Master (one command)

```bash
curl -fsSL https://raw.githubusercontent.com/Beykus-Y/Admin_vps/main/scripts/install-master.sh | sudo bash
```

The script will:
1. Install Docker (if not present)
2. Ask for your domain/IP and admin credentials
3. Download configs, generate `JWT_SECRET`
4. Pull images from ghcr.io, run migrations, start services
5. Create admin user
6. Register `filincontrol.service` (auto-start on reboot)
7. Install the local agent on the master VPS so the master appears as a node

---

## Quick Start (local build)

```bash
cd deploy
cp .env.example .env
# Edit .env: JWT_SECRET=$(openssl rand -hex 32)
# Edit caddy/Caddyfile: replace panel.example.com with your domain

docker compose -f docker-compose.yml run --rm migrate
docker compose -f docker-compose.yml up -d
```

## Quick Start (production, pre-built images from ghcr.io)

```bash
cd deploy
cp .env.example .env
# Edit .env and Caddyfile

docker compose -f docker-compose.prod.yml run --rm migrate
docker compose -f docker-compose.prod.yml up -d
```

## Create first admin user

```bash
curl -X POST https://panel.example.com/api/auth/init \
  -H "Content-Type: application/json" \
  -d '{"username": "admin", "password": "your_password"}'
```

> Works only once — when no users exist.

## Add a node

1. Open the panel → **Nodes** → **Add Node**
2. Copy the install command
3. Run it on your VPS:

```bash
curl -fsSL https://raw.githubusercontent.com/Beykus-Y/Admin_vps/main/scripts/install-agent.sh \
  | sudo bash -s -- \
    --master-url "https://panel.example.com" \
    --enroll-token "fna_enroll_..."
```

## Update an agent (1-click)

Open the panel → Node detail → click **Update Agent**.
The backend fetches the latest release from GitHub, creates an `agent.update` task, and the agent replaces itself and restarts.

To let the master schedule updates for outdated online agents automatically, set:

```env
AGENT_AUTO_UPDATE_ENABLED=true
```

## Update Master (1-click)

Open the panel → click **Update Master** in the sidebar.
This requires the master VPS to have its local agent installed and marked with the `master` tag. New master installs do this automatically.

---

## CI/CD

| Workflow | Trigger | Result |
|----------|---------|--------|
| `release.yml` | push to `main` or manual dispatch | Reads `VERSION`, creates missing master/agent releases, pushes Docker images and agent binaries |
| `docker.yml` | manual dispatch | Manually builds and pushes master Docker images |
| `agent-release.yml` | manual dispatch | Manually builds Linux amd64/arm64 binaries and creates an agent release |
| `deploy.yml` | manual dispatch | SSH deploy to VPS |

### Versioned releases

Update `VERSION` and push to `main`:

```text
Master=0.1.2
Agent=0.1.1
```

The release workflow compares these versions with existing tags:

- missing `master/vX.Y.Z` → builds API/web images, tags them as `latest` and `X.Y.Z`, creates a master release;
- missing `agent/vX.Y.Z` → builds `filin-agent-linux-amd64` and `filin-agent-linux-arm64`, creates an agent release;
- existing tag → skips that component.

### Setup auto-deploy (optional)

Add these secrets in GitHub → Settings → Secrets:
- `VPS_HOST` — your master VPS IP
- `VPS_USER` — SSH username (e.g. `root`)
- `VPS_SSH_KEY` — private SSH key

---

## Architecture

```
Master (FastAPI + PostgreSQL + Redis + Next.js) — ghcr.io images
    ↑ HTTPS/WSS
Agent (Go binary, systemd service, on each VPS)
    ↑ self-updates from GitHub Releases
```

## Stack

| Component | Tech |
|-----------|------|
| Backend API | FastAPI + SQLAlchemy + asyncpg |
| Database | PostgreSQL 16 |
| Frontend | Next.js 15 + Tailwind CSS |
| Agent | Go 1.23 |
| Reverse proxy | Caddy 2 |
| Deployment | Docker Compose |
| CI/CD | GitHub Actions + ghcr.io |

## Project Structure

```
apps/
  master-api/     FastAPI backend
  web-panel/      Next.js frontend
  agent/          Go agent
deploy/
  docker-compose.yml       local build
  docker-compose.prod.yml  pre-built images
  caddy/Caddyfile
.github/workflows/
  release.yml       VERSION-driven master/agent releases
  docker.yml        manual image build fallback
  agent-release.yml manual agent release fallback
  deploy.yml        SSH deploy to VPS
scripts/
  install-agent.sh  one-command agent installer
```
