# FilinControl

VPS infrastructure management panel. One panel — all your servers.

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

---

## CI/CD

| Workflow | Trigger | Result |
|----------|---------|--------|
| `docker.yml` | push to `main` (apps/master-api or apps/web-panel) | Builds & pushes `ghcr.io/beykus-y/filincontrol-api:latest` and `filincontrol-web:latest` |
| `agent-release.yml` | push tag `agent/v*` or manual dispatch | Builds Linux amd64/arm64 binaries, creates GitHub Release |
| `deploy.yml` | after Docker images built, or manual | SSH deploy to VPS |

### Publish a new agent release

```bash
git tag agent/v0.2.0
git push origin agent/v0.2.0
```

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
  docker.yml        build & push images
  agent-release.yml release agent binaries
  deploy.yml        SSH deploy to VPS
scripts/
  install-agent.sh  one-command agent installer
```
