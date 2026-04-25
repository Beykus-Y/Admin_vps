import uuid
from datetime import UTC, datetime, timedelta

import httpx
from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select

from app.api.deps import DB, CurrentUser
from app.core.config import settings
from app.core.security import generate_enroll_token, hash_token
from app.db.models import DockerContainer, Event, Node, NodeEnrollToken, OpenPort, Task
from app.schemas.node import NodeCreate, NodeEnrollTokenOut, NodeOut
from app.schemas.task import ALLOWED_TASK_TYPES, TaskCreate, TaskOutFull

router = APIRouter(prefix="/nodes", tags=["nodes"])

GITHUB_REPO = "Beykus-Y/Admin_vps"


@router.post("", response_model=NodeOut, status_code=201)
async def create_node(body: NodeCreate, _: CurrentUser, db: DB):
    node = Node(
        name=body.name,
        provider=body.provider,
        location=body.location,
        group_name=body.group_name,
        tags=body.tags,
        status="pending",
    )
    db.add(node)
    await db.commit()
    await db.refresh(node)
    return node


@router.get("", response_model=list[NodeOut])
async def list_nodes(_: CurrentUser, db: DB):
    result = await db.execute(select(Node).order_by(Node.created_at.desc()))
    return result.scalars().all()


@router.get("/{node_id}", response_model=NodeOut)
async def get_node(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


@router.delete("/{node_id}", status_code=204)
async def delete_node(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    await db.delete(node)
    await db.commit()


@router.post("/{node_id}/enroll-token", response_model=NodeEnrollTokenOut)
async def create_enroll_token(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    raw_token = generate_enroll_token()
    expires_at = datetime.now(UTC) + timedelta(minutes=settings.enroll_token_expire_minutes)
    enroll = NodeEnrollToken(node_id=node.id, token_hash=hash_token(raw_token), expires_at=expires_at)
    db.add(enroll)
    await db.commit()

    install_cmd = (
        f'curl -fsSL https://panel.example.com/install/agent.sh | sudo bash -s -- '
        f'--master-url "https://panel.example.com" '
        f'--enroll-token "{raw_token}"'
    )
    return NodeEnrollTokenOut(install_command=install_cmd, enroll_token=raw_token, expires_at=expires_at)


@router.get("/{node_id}/containers")
async def get_containers(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(select(DockerContainer).where(DockerContainer.node_id == node_id))
    containers = result.scalars().all()
    return [
        {
            "id": str(c.id),
            "container_id": c.container_id,
            "name": c.name,
            "image": c.image,
            "status": c.status,
            "state": c.state,
            "ports": c.ports,
            "cpu_percent": c.cpu_percent,
            "ram_mb": c.ram_mb,
            "restart_count": c.restart_count,
            "health_status": c.health_status,
            "updated_at": c.updated_at.isoformat() if c.updated_at else None,
        }
        for c in containers
    ]


@router.get("/{node_id}/ports")
async def get_ports(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(select(OpenPort).where(OpenPort.node_id == node_id).order_by(OpenPort.port))
    ports = result.scalars().all()
    return [
        {
            "id": str(p.id),
            "protocol": p.protocol,
            "port": p.port,
            "listen_ip": p.listen_ip,
            "process_name": p.process_name,
            "container_name": p.container_name,
            "is_expected": p.is_expected,
            "first_seen_at": p.first_seen_at.isoformat() if p.first_seen_at else None,
            "last_seen_at": p.last_seen_at.isoformat() if p.last_seen_at else None,
        }
        for p in ports
    ]


@router.patch("/{node_id}/ports/{port_id}/expected", status_code=204)
async def mark_port_expected(node_id: uuid.UUID, port_id: uuid.UUID, expected: bool, _: CurrentUser, db: DB):
    result = await db.execute(select(OpenPort).where(OpenPort.id == port_id, OpenPort.node_id == node_id))
    port = result.scalar_one_or_none()
    if not port:
        raise HTTPException(status_code=404, detail="Port not found")
    port.is_expected = expected
    await db.commit()


@router.get("/{node_id}/tasks", response_model=list[TaskOutFull])
async def get_node_tasks(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(
        select(Task).where(Task.node_id == node_id).order_by(Task.created_at.desc()).limit(50)
    )
    return result.scalars().all()


@router.post("/{node_id}/tasks", response_model=TaskOutFull, status_code=201)
async def create_task(node_id: uuid.UUID, body: TaskCreate, _: CurrentUser, db: DB):
    if body.type not in ALLOWED_TASK_TYPES:
        raise HTTPException(status_code=400, detail=f"Task type '{body.type}' is not allowed")

    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    task = Task(node_id=node_id, type=body.type, payload=body.payload)
    db.add(task)
    await db.commit()
    await db.refresh(task)
    return task


@router.get("/{node_id}/events")
async def get_node_events(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(
        select(Event).where(Event.node_id == node_id).order_by(Event.created_at.desc()).limit(100)
    )
    events = result.scalars().all()
    return [
        {
            "id": str(e.id),
            "severity": e.severity,
            "type": e.type,
            "message": e.message,
            "extra": e.extra,
            "created_at": e.created_at.isoformat(),
        }
        for e in events
    ]


@router.post("/{node_id}/update-agent", response_model=TaskOutFull, status_code=201)
async def update_agent(node_id: uuid.UUID, _: CurrentUser, db: DB):
    """Fetch latest agent release from GitHub, create agent.update task."""
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    if node.status != "online":
        raise HTTPException(status_code=400, detail="Node is not online")

    # Determine arch: default to amd64, support arm64
    arch = "amd64"
    if node.arch and "arm" in node.arch.lower():
        arch = "arm64"

    # Fetch latest release info from GitHub API
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            resp = await client.get(
                f"https://api.github.com/repos/{GITHUB_REPO}/releases/latest",
                headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28"},
            )
            resp.raise_for_status()
            release = resp.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to fetch latest release from GitHub: {e}")

    tag_name = release.get("tag_name", "")
    assets = release.get("assets", [])

    binary_name = f"filin-agent-linux-{arch}"
    checksum_name = f"filin-agent-linux-{arch}.sha256"

    download_url = next((a["browser_download_url"] for a in assets if a["name"] == binary_name), None)
    checksum_url = next((a["browser_download_url"] for a in assets if a["name"] == checksum_name), None)

    if not download_url:
        raise HTTPException(status_code=404, detail=f"No release asset '{binary_name}' found in latest release {tag_name}")

    checksum_sha256 = None
    if checksum_url:
        try:
            async with httpx.AsyncClient(timeout=10) as client:
                cr = await client.get(checksum_url)
                cr.raise_for_status()
                # file format: "<hash>  filin-agent-linux-amd64"
                checksum_sha256 = cr.text.split()[0]
        except Exception:
            pass  # proceed without checksum verification

    payload = {
        "download_url": download_url,
        "version": tag_name,
        "arch": arch,
    }
    if checksum_sha256:
        payload["checksum_sha256"] = checksum_sha256

    task = Task(node_id=node_id, type="agent.update", payload=payload)
    db.add(task)
    db.add(Event(
        node_id=node_id,
        severity="info",
        type="agent.update_scheduled",
        message=f"Agent update to {tag_name} ({arch}) scheduled",
        extra={"version": tag_name, "arch": arch},
    ))
    await db.commit()
    await db.refresh(task)
    return task
