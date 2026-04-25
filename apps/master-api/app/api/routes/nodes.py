import uuid
import shlex
from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy import select

from app.api.deps import CurrentAdmin, CurrentOperator, CurrentUser, DB
from app.core.config import settings
from app.core.security import generate_enroll_token, hash_token
from app.db.models import DockerContainer, Event, Node, NodeEnrollToken, NodeMetric, OpenPort, Task
from app.schemas.node import NodeCreate, NodeEnrollTokenOut, NodeMetricOut, NodeOut
from app.schemas.task import ALLOWED_TASK_TYPES, TaskCreate, TaskOutFull
from app.services.agent_releases import build_agent_update_payload, is_agent_outdated
from app.services.audit import log_action
from app.services.events import is_noisy_port_event
from app.services.realtime import publish_event

router = APIRouter(prefix="/nodes", tags=["nodes"])

GITHUB_REPO = "Beykus-Y/Admin_vps"
AGENT_INSTALLER_URL = f"https://raw.githubusercontent.com/{GITHUB_REPO}/main/scripts/install-agent.sh"


class NodeMetricHistoryPoint(BaseModel):
    created_at: datetime
    cpu_percent: float | None = None
    ram_used_mb: int | None = None
    ram_total_mb: int | None = None
    disk_used_gb: float | None = None
    disk_total_gb: float | None = None
    load_1: float | None = None
    load_5: float | None = None
    load_15: float | None = None
    network_rx_bytes: int | None = None
    network_tx_bytes: int | None = None

    model_config = {"from_attributes": True}


def external_base_url(request: Request) -> str:
    proto = request.headers.get("x-forwarded-proto", request.url.scheme).split(",")[0].strip()
    host = (
        request.headers.get("x-forwarded-host")
        or request.headers.get("host")
        or request.url.netloc
    )
    return f"{proto}://{host}".rstrip("/")


@router.post("", response_model=NodeOut, status_code=201)
async def create_node(body: NodeCreate, user: CurrentOperator, db: DB):
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
    await log_action(
        db,
        user=user,
        action="nodes.create",
        target_type="node",
        target_id=str(node.id),
        node_id=node.id,
        message=f"Node {node.name} created",
        details={"provider": node.provider, "location": node.location, "group_name": node.group_name, "tags": node.tags},
    )
    await db.commit()
    await publish_event("inventory.changed", {"node_id": str(node.id), "action": "created"})
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
async def delete_node(node_id: uuid.UUID, user: CurrentAdmin, db: DB):
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    await log_action(
        db,
        user=user,
        action="nodes.delete",
        target_type="node",
        target_id=str(node.id),
        node_id=node.id,
        message=f"Node {node.name} deleted",
        details={"name": node.name},
    )
    await db.delete(node)
    await db.commit()
    await publish_event("inventory.changed", {"node_id": str(node_id), "action": "deleted"})


@router.post("/{node_id}/enroll-token", response_model=NodeEnrollTokenOut)
async def create_enroll_token(node_id: uuid.UUID, request: Request, user: CurrentOperator, db: DB):
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    raw_token = generate_enroll_token()
    expires_at = datetime.now(UTC) + timedelta(minutes=settings.enroll_token_expire_minutes)
    enroll = NodeEnrollToken(node_id=node.id, token_hash=hash_token(raw_token), expires_at=expires_at)
    db.add(enroll)
    await db.commit()

    master_url = external_base_url(request)
    install_cmd = (
        f"curl -fsSL {shlex.quote(AGENT_INSTALLER_URL)} | sudo bash -s -- "
        f"--master-url {shlex.quote(master_url)} "
        f"--enroll-token {shlex.quote(raw_token)}"
    )
    await log_action(
        db,
        user=user,
        action="nodes.enroll_token.create",
        target_type="node",
        target_id=str(node.id),
        node_id=node.id,
        message=f"Enroll token created for {node.name}",
        details={"expires_at": expires_at.isoformat()},
    )
    await db.commit()
    return NodeEnrollTokenOut(install_command=install_cmd, enroll_token=raw_token, expires_at=expires_at)


@router.get("/{node_id}/containers")
async def get_containers(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(select(DockerContainer).where(DockerContainer.node_id == node_id).order_by(DockerContainer.name))
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
            "networks": c.networks,
            "mounts": c.mounts,
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
    node_result = await db.execute(select(Node).where(Node.id == node_id))
    node = node_result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")

    result = await db.execute(select(OpenPort).where(OpenPort.node_id == node_id).order_by(OpenPort.port))
    ports = result.scalars().all()
    fresh_after = datetime.now(UTC) - timedelta(seconds=max(settings.node_offline_threshold_seconds * 2, 90))
    return [
        {
            "id": str(p.id),
            "protocol": p.protocol,
            "port": p.port,
            "listen_ip": p.listen_ip,
            "process_name": p.process_name,
            "pid": p.pid,
            "user_name": p.user_name,
            "container_name": p.container_name,
            "is_expected": p.is_expected,
            "status": "open" if node.status == "online" and p.last_seen_at and p.last_seen_at >= fresh_after else "stale",
            "first_seen_at": p.first_seen_at.isoformat() if p.first_seen_at else None,
            "last_seen_at": p.last_seen_at.isoformat() if p.last_seen_at else None,
        }
        for p in ports
    ]


@router.patch("/{node_id}/ports/{port_id}/expected", status_code=204)
async def mark_port_expected(node_id: uuid.UUID, port_id: uuid.UUID, expected: bool, user: CurrentOperator, db: DB):
    result = await db.execute(select(OpenPort).where(OpenPort.id == port_id, OpenPort.node_id == node_id))
    port = result.scalar_one_or_none()
    if not port:
        raise HTTPException(status_code=404, detail="Port not found")
    port.is_expected = expected
    await log_action(
        db,
        user=user,
        action="ports.expected.update",
        target_type="port",
        target_id=str(port.id),
        node_id=node_id,
        message=f"Port {port.protocol}/{port.port} expected={expected}",
        details={"expected": expected},
    )
    await db.commit()
    await publish_event("inventory.changed", {"node_id": str(node_id), "port_id": str(port.id), "action": "port_expected"})


@router.get("/{node_id}/metrics/latest", response_model=NodeMetricOut | None)
async def get_latest_metrics(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(
        select(NodeMetric)
        .where(NodeMetric.node_id == node_id)
        .order_by(NodeMetric.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


@router.get("/{node_id}/metrics/history", response_model=list[NodeMetricHistoryPoint])
async def get_metric_history(node_id: uuid.UUID, _: CurrentUser, db: DB, range: str = "24h", points: int = 48):
    amount = 24
    unit = "h"
    if range.endswith("d"):
        amount = int(range[:-1] or "7")
        unit = "d"
    elif range.endswith("h"):
        amount = int(range[:-1] or "24")
    else:
        raise HTTPException(status_code=400, detail="Invalid range, use formats like 24h or 7d")

    delta = timedelta(days=amount) if unit == "d" else timedelta(hours=amount)
    since = datetime.now(UTC) - delta
    result = await db.execute(
        select(NodeMetric)
        .where(NodeMetric.node_id == node_id, NodeMetric.created_at >= since)
        .order_by(NodeMetric.created_at.asc())
    )
    rows = result.scalars().all()
    if len(rows) <= max(points, 2):
        return rows

    stride = max(1, len(rows) // points)
    sampled = rows[::stride]
    if sampled[-1].id != rows[-1].id:
        sampled.append(rows[-1])
    return sampled


@router.get("/{node_id}/tasks", response_model=list[TaskOutFull])
async def get_node_tasks(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(
        select(Task).where(Task.node_id == node_id).order_by(Task.created_at.desc()).limit(50)
    )
    return result.scalars().all()


@router.post("/{node_id}/tasks", response_model=TaskOutFull, status_code=201)
async def create_task(node_id: uuid.UUID, body: TaskCreate, user: CurrentOperator, db: DB):
    if body.type not in ALLOWED_TASK_TYPES:
        raise HTTPException(status_code=400, detail=f"Task type '{body.type}' is not allowed")

    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if node.capabilities and body.type not in node.capabilities:
        raise HTTPException(status_code=400, detail=f"Node agent does not advertise capability '{body.type}'")

    task = Task(node_id=node_id, type=body.type, payload=body.payload)
    db.add(task)
    await db.flush()
    await log_action(
        db,
        user=user,
        action="tasks.create",
        target_type="task",
        target_id=str(task.id),
        node_id=node_id,
        message=f"Task {body.type} created for {node.name}",
        details={"type": body.type, "payload": body.payload},
    )
    await db.commit()
    await db.refresh(task)
    await publish_event("tasks.changed", {"task_id": str(task.id), "node_id": str(node_id), "type": body.type})
    return task


@router.get("/{node_id}/events")
async def get_node_events(node_id: uuid.UUID, _: CurrentUser, db: DB):
    result = await db.execute(
        select(Event).where(Event.node_id == node_id).order_by(Event.created_at.desc()).limit(300)
    )
    events = [e for e in result.scalars().all() if not is_noisy_port_event(e)][:100]
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


async def create_agent_update_task(node: Node, payload: dict, db: DB) -> Task:
    existing_result = await db.execute(
        select(Task).where(
            Task.node_id == node.id,
            Task.type == "agent.update",
            Task.status.in_(["pending", "running"]),
        )
    )
    existing = existing_result.scalar_one_or_none()
    if existing:
        return existing

    task = Task(node_id=node.id, type="agent.update", payload=payload)
    db.add(task)
    db.add(Event(
        node_id=node.id,
        severity="info",
        type="agent.update_scheduled",
        message=f"Agent update to {payload.get('version')} ({payload.get('arch')}) scheduled",
        extra={"version": payload.get("version"), "arch": payload.get("arch")},
    ))
    await db.flush()
    return task


@router.post("/{node_id}/update-agent", response_model=TaskOutFull, status_code=201)
async def update_agent(node_id: uuid.UUID, user: CurrentOperator, db: DB):
    """Fetch latest agent release from GitHub and create an agent.update task."""
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    if node.status != "online":
        raise HTTPException(status_code=400, detail="Node is not online")

    try:
        payload = await build_agent_update_payload(node.arch)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to resolve latest agent release: {e}")

    task = await create_agent_update_task(node, payload, db)
    await log_action(
        db,
        user=user,
        action="agent.update.schedule",
        target_type="task",
        target_id=str(task.id),
        node_id=node.id,
        message=f"Agent update scheduled for {node.name}",
        details=payload,
    )
    await db.commit()
    await db.refresh(task)
    await publish_event("tasks.changed", {"task_id": str(task.id), "node_id": str(node.id), "type": task.type})
    return task


@router.post("/update-agents", response_model=list[TaskOutFull], status_code=201)
async def update_outdated_agents(user: CurrentOperator, db: DB):
    try:
        payload_by_arch = {
            "amd64": await build_agent_update_payload("amd64"),
            "arm64": await build_agent_update_payload("arm64"),
        }
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Failed to resolve latest agent release: {e}")

    latest_version = payload_by_arch["amd64"].get("version")
    nodes_result = await db.execute(select(Node).where(Node.status == "online"))
    nodes = nodes_result.scalars().all()
    tasks: list[Task] = []
    for node in nodes:
        if not is_agent_outdated(node.agent_version, latest_version):
            continue
        arch = "arm64" if node.arch and "arm" in node.arch.lower() else "amd64"
        tasks.append(await create_agent_update_task(node, payload_by_arch[arch], db))

    await db.commit()
    for task in tasks:
        await db.refresh(task)
        await log_action(
            db,
            user=user,
            action="agent.update.schedule_bulk",
            target_type="task",
            target_id=str(task.id),
            node_id=task.node_id,
            message="Bulk agent update scheduled",
            details=task.payload,
        )
    if tasks:
        await db.commit()
        await publish_event("tasks.changed", {"count": len(tasks), "type": "agent.update"})
    return tasks
