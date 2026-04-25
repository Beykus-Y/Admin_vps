import shlex
import uuid
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
from app.services.inventory import serialize_container, serialize_metric, serialize_node, serialize_port
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


async def get_node_or_404(node_id: uuid.UUID, db: DB) -> Node:
    result = await db.execute(select(Node).where(Node.id == node_id))
    node = result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=404, detail="Node not found")
    return node


async def load_node_containers(node_id: uuid.UUID, db: DB) -> list[DockerContainer]:
    result = await db.execute(select(DockerContainer).where(DockerContainer.node_id == node_id).order_by(DockerContainer.name))
    return result.scalars().all()


async def load_node_ports(node_id: uuid.UUID, db: DB) -> list[OpenPort]:
    result = await db.execute(select(OpenPort).where(OpenPort.node_id == node_id).order_by(OpenPort.port))
    return result.scalars().all()


async def load_latest_metric(node_id: uuid.UUID, db: DB) -> NodeMetric | None:
    result = await db.execute(
        select(NodeMetric)
        .where(NodeMetric.node_id == node_id)
        .order_by(NodeMetric.created_at.desc())
        .limit(1)
    )
    return result.scalar_one_or_none()


async def load_metric_history(node_id: uuid.UUID, db: DB, range_value: str = "24h", points: int = 48) -> list[NodeMetric]:
    amount = 24
    unit = "h"
    if range_value.endswith("d"):
        amount = int(range_value[:-1] or "7")
        unit = "d"
    elif range_value.endswith("h"):
        amount = int(range_value[:-1] or "24")
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


async def load_node_tasks(node_id: uuid.UUID, db: DB) -> list[Task]:
    result = await db.execute(
        select(Task).where(Task.node_id == node_id).order_by(Task.created_at.desc()).limit(50)
    )
    return result.scalars().all()


async def load_node_events(node_id: uuid.UUID, db: DB) -> list[Event]:
    result = await db.execute(
        select(Event).where(Event.node_id == node_id).order_by(Event.created_at.desc()).limit(300)
    )
    return [event for event in result.scalars().all() if not is_noisy_port_event(event)][:100]


def serialize_event(event: Event) -> dict:
    return {
        "id": str(event.id),
        "node_id": str(event.node_id) if event.node_id else None,
        "severity": event.severity,
        "type": event.type,
        "message": event.message,
        "extra": event.extra,
        "created_at": event.created_at.isoformat(),
    }


def serialize_task(task: Task) -> dict:
    return {
        "id": str(task.id),
        "node_id": str(task.node_id),
        "type": task.type,
        "payload": task.payload,
        "status": task.status,
        "result": task.result,
        "error": task.error,
        "created_at": task.created_at.isoformat(),
        "started_at": task.started_at.isoformat() if task.started_at else None,
        "finished_at": task.finished_at.isoformat() if task.finished_at else None,
    }


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
    return await get_node_or_404(node_id, db)


@router.get("/{node_id}/details")
async def get_node_details(node_id: uuid.UUID, _: CurrentUser, db: DB, range: str = "24h", points: int = 48):
    node = await get_node_or_404(node_id, db)
    containers = await load_node_containers(node_id, db)
    ports = await load_node_ports(node_id, db)
    latest_metric = await load_latest_metric(node_id, db)
    history = await load_metric_history(node_id, db, range, points)
    tasks = await load_node_tasks(node_id, db)
    events = await load_node_events(node_id, db)
    return {
        "node": serialize_node(node),
        "containers": [serialize_container(container) for container in containers],
        "ports": [serialize_port(port, node_status=node.status) for port in ports],
        "metrics": serialize_metric(latest_metric),
        "history": [serialize_metric(metric) for metric in history],
        "tasks": [serialize_task(task) for task in tasks],
        "events": [serialize_event(event) for event in events],
    }


@router.delete("/{node_id}", status_code=204)
async def delete_node(node_id: uuid.UUID, user: CurrentAdmin, db: DB):
    node = await get_node_or_404(node_id, db)
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
    node = await get_node_or_404(node_id, db)

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
    containers = await load_node_containers(node_id, db)
    return [serialize_container(container) for container in containers]


@router.get("/{node_id}/ports")
async def get_ports(node_id: uuid.UUID, _: CurrentUser, db: DB):
    node = await get_node_or_404(node_id, db)
    ports = await load_node_ports(node_id, db)
    return [serialize_port(port, node_status=node.status) for port in ports]


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
    return await load_latest_metric(node_id, db)


@router.get("/{node_id}/metrics/history", response_model=list[NodeMetricHistoryPoint])
async def get_metric_history(node_id: uuid.UUID, _: CurrentUser, db: DB, range: str = "24h", points: int = 48):
    return await load_metric_history(node_id, db, range, points)


@router.get("/{node_id}/tasks", response_model=list[TaskOutFull])
async def get_node_tasks(node_id: uuid.UUID, _: CurrentUser, db: DB):
    return await load_node_tasks(node_id, db)


@router.post("/{node_id}/tasks", response_model=TaskOutFull, status_code=201)
async def create_task(node_id: uuid.UUID, body: TaskCreate, user: CurrentOperator, db: DB):
    if body.type not in ALLOWED_TASK_TYPES:
        raise HTTPException(status_code=400, detail=f"Task type '{body.type}' is not allowed")

    node = await get_node_or_404(node_id, db)
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
    events = await load_node_events(node_id, db)
    return [serialize_event(event) for event in events]


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
    node = await get_node_or_404(node_id, db)
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
