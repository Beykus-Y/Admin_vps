from datetime import UTC, datetime, timedelta

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.api.deps import DB, AgentNode
from app.core.config import settings
from app.core.security import generate_agent_token, hash_token
from app.db.models import AlertIncident, AlertRule, DockerContainer, Event, Node, NodeCredential, NodeEnrollToken, NodeMetric, OpenPort, Task
from app.schemas.agent import (
    EnrollRequest,
    EnrollResponse,
    HeartbeatBotConfig,
    HeartbeatRequest,
    HeartbeatResponse,
    SnapshotRequest,
    TaskOut,
    TaskResultRequest,
)
from app.services.alerts import (
    evaluate_node_inventory_alerts,
    evaluate_offline_alert,
    list_notification_channels,
    notification_payload,
)
from app.services.app_settings import TELEGRAM_BOT_SETTING_KEY, get_setting
from app.services.events import is_noisy_dynamic_udp_port
from app.services.notifications import dispatch_channels
from app.services.realtime import publish_event

router = APIRouter(prefix="/agent", tags=["agent"])


@router.post("/enroll", response_model=EnrollResponse)
async def enroll(body: EnrollRequest, db: DB):
    token_hash = hash_token(body.enroll_token)
    now = datetime.now(UTC)

    result = await db.execute(
        select(NodeEnrollToken).where(
            NodeEnrollToken.token_hash == token_hash,
            NodeEnrollToken.used_at == None,
            NodeEnrollToken.expires_at > now,
        )
    )
    enroll_token = result.scalar_one_or_none()
    if not enroll_token:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid or expired enroll token")

    node_result = await db.execute(select(Node).where(Node.id == enroll_token.node_id))
    node = node_result.scalar_one_or_none()
    if not node:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Node not found")

    enroll_token.used_at = now
    node.hostname = body.hostname
    node.public_ip = body.public_ip
    node.os = body.os
    node.arch = body.arch
    node.agent_version = body.agent_version
    node.capabilities = body.capabilities or []
    node.status = "online"
    node.last_seen_at = now

    raw_token = generate_agent_token()
    cred = NodeCredential(node_id=node.id, token_hash=hash_token(raw_token))
    db.add(cred)
    await db.commit()
    await publish_event("inventory.changed", {"node_id": str(node.id), "status": node.status, "action": "enrolled"})

    return EnrollResponse(
        node_id=str(node.id),
        agent_token=raw_token,
        config={
            "collect_interval_seconds": 10,
            "task_poll_interval_seconds": 5,
        },
    )


@router.post("/heartbeat", response_model=HeartbeatResponse)
async def heartbeat(body: HeartbeatRequest, node: AgentNode, db: DB):
    now = datetime.now(UTC)
    previous_status = node.status
    previous_version = node.agent_version
    previous_capabilities = node.capabilities or []

    node.last_seen_at = now
    node.status = "online"
    if body.agent_version:
        node.agent_version = body.agent_version
    if body.capabilities:
        node.capabilities = body.capabilities

    status_changed = previous_status != "online"
    version_changed = bool(body.agent_version and body.agent_version != previous_version)
    capabilities_changed = bool(body.capabilities and body.capabilities != previous_capabilities)

    if previous_status == "offline":
        db.add(Event(
            node_id=node.id,
            severity="info",
            type="node.back_online",
            message=f"Node {node.name} is back online",
        ))

    notifications = await evaluate_offline_alert(db, node=node, active=False)
    await db.commit()
    if notifications:
        for envelope in notifications:
            channels = await list_notification_channels(db, envelope.severity, status=envelope.status)
            channel_payloads = [
                {
                    "id": channel.id,
                    "name": channel.name,
                    "type": channel.type,
                    "config": channel.config or {},
                    "send_resolved": channel.send_resolved,
                }
                for channel in channels
            ]
            if channel_payloads:
                await dispatch_channels(channel_payloads, notification_payload(envelope))
    if status_changed or version_changed or capabilities_changed:
        await publish_event("inventory.changed", {"node_id": str(node.id), "status": node.status, "action": "heartbeat_changed"})

    bot_setting = await get_setting(db, TELEGRAM_BOT_SETTING_KEY)
    is_bot_runner = str(bot_setting.get("runner_node_id", "")) == str(node.id)
    bot_config = None
    if is_bot_runner and bot_setting.get("bot_token"):
        bot_config = HeartbeatBotConfig(
            bot_token=bot_setting["bot_token"],
            allowed_chat_ids=bot_setting.get("allowed_chat_ids") or [],
        )
    return HeartbeatResponse(is_bot_runner=is_bot_runner, bot_config=bot_config)


@router.post("/snapshot", status_code=204)
async def snapshot(body: SnapshotRequest, node: AgentNode, db: DB):
    now = datetime.now(UTC)
    node.last_seen_at = now
    node.status = "online"
    if body.capabilities:
        node.capabilities = body.capabilities

    if body.system:
        system = body.system
        if system.hostname:
            node.hostname = system.hostname
        if system.public_ip:
            node.public_ip = system.public_ip
        if system.os:
            node.os = system.os
        if system.arch:
            node.arch = system.arch
        node.uptime_seconds = system.uptime_seconds
        node.kernel = system.kernel
        node.cpu_model = system.cpu_model
        node.cpu_cores = system.cpu_cores
        node.local_ips = system.local_ips

    if body.metrics:
        m = body.metrics
        db.add(NodeMetric(
            node_id=node.id,
            cpu_percent=m.cpu_percent,
            ram_used_mb=m.ram_used_mb,
            ram_total_mb=m.ram_total_mb,
            disk_used_gb=m.disk_used_gb,
            disk_total_gb=m.disk_total_gb,
            load_1=m.load_1,
            load_5=m.load_5,
            load_15=m.load_15,
            network_rx_bytes=m.network_rx_bytes,
            network_tx_bytes=m.network_tx_bytes,
        ))

    if body.containers_collected:
        seen_container_ids = [c.container_id for c in body.containers]
        for c in body.containers:
            stmt = (
                pg_insert(DockerContainer)
                .values(
                    node_id=node.id,
                    container_id=c.container_id,
                    name=c.name,
                    image=c.image,
                    status=c.status,
                    state=c.state,
                    ports=c.ports,
                    networks=c.networks,
                    mounts=c.mounts,
                    labels=c.labels,
                    cpu_percent=c.cpu_percent,
                    ram_mb=c.ram_mb,
                    restart_count=c.restart_count,
                    health_status=c.health_status,
                    updated_at=now,
                )
                .on_conflict_do_update(
                    index_elements=["node_id", "container_id"],
                    set_={
                        "name": c.name,
                        "image": c.image,
                        "status": c.status,
                        "state": c.state,
                        "ports": c.ports,
                        "networks": c.networks,
                        "mounts": c.mounts,
                        "labels": c.labels,
                        "cpu_percent": c.cpu_percent,
                        "ram_mb": c.ram_mb,
                        "restart_count": c.restart_count,
                        "health_status": c.health_status,
                        "updated_at": now,
                    },
                )
            )
            await db.execute(stmt)
        cleanup = delete(DockerContainer).where(DockerContainer.node_id == node.id)
        if seen_container_ids:
            cleanup = cleanup.where(DockerContainer.container_id.not_in(seen_container_ids))
        await db.execute(cleanup)

    if body.ports_collected:
        existing_ports_result = await db.execute(select(OpenPort).where(OpenPort.node_id == node.id))
        existing_ports = {(p.protocol, p.port, p.listen_ip): p for p in existing_ports_result.scalars()}

        for p in body.ports:
            key = (p.protocol, p.port, p.listen_ip)
            if key in existing_ports:
                existing_ports[key].last_seen_at = now
                existing_ports[key].process_name = p.process_name
                existing_ports[key].pid = p.pid
                existing_ports[key].user_name = p.user_name
                existing_ports[key].container_name = p.container_name
            else:
                should_alert = not is_noisy_dynamic_udp_port(p.protocol, p.port, p.process_name)
                new_port = OpenPort(
                    node_id=node.id,
                    protocol=p.protocol,
                    port=p.port,
                    listen_ip=p.listen_ip,
                    process_name=p.process_name,
                    pid=p.pid,
                    user_name=p.user_name,
                    container_name=p.container_name,
                    is_expected=False,
                )
                db.add(new_port)
                if should_alert:
                    db.add(Event(
                        node_id=node.id,
                        severity="warning",
                        type="port.new_unexpected",
                        message=f"New port opened: {p.protocol}/{p.port} on {p.listen_ip} (process: {p.process_name})",
                        extra={"port": p.port, "protocol": p.protocol, "listen_ip": p.listen_ip, "process": p.process_name},
                    ))

    for message in body.errors:
        event_exists = await db.execute(
            select(Event.id).where(
                Event.node_id == node.id,
                Event.type == "agent.inventory_error",
                Event.message == message,
                Event.created_at > now - timedelta(minutes=15),
            )
        )
        if not event_exists.scalar_one_or_none():
            db.add(Event(
                node_id=node.id,
                severity="warning",
                type="agent.inventory_error",
                message=message,
                extra={},
            ))

    await db.flush()
    notifications = await evaluate_node_inventory_alerts(
        db,
        node=node,
        metrics=body.metrics,
        containers=body.containers,
        containers_collected=body.containers_collected,
        ports_collected=body.ports_collected,
    )

    await db.commit()
    for envelope in notifications:
        channels = await list_notification_channels(db, envelope.severity, status=envelope.status)
        channel_payloads = [
            {
                "id": channel.id,
                "name": channel.name,
                "type": channel.type,
                "config": channel.config or {},
                "send_resolved": channel.send_resolved,
            }
            for channel in channels
        ]
        if channel_payloads:
            await dispatch_channels(channel_payloads, notification_payload(envelope))
    await publish_event("inventory.changed", {"node_id": str(node.id), "status": node.status})


@router.get("/tasks", response_model=list[TaskOut])
async def get_tasks(node: AgentNode, db: DB):
    now = datetime.now(UTC)
    retry_after = now - timedelta(minutes=15)
    result = await db.execute(
        select(Task)
        .where(
            Task.node_id == node.id,
            (Task.status == "pending")
            | ((Task.status == "running") & (Task.started_at < retry_after)),
        )
        .order_by(Task.created_at.asc())
        .limit(1)
    )
    tasks = result.scalars().all()
    for task in tasks:
        task.status = "running"
        task.started_at = now
    if tasks:
        await db.commit()
    return [TaskOut(id=str(t.id), type=t.type, payload=t.payload) for t in tasks]


@router.post("/tasks/{task_id}/result", status_code=204)
async def submit_task_result(task_id: str, body: TaskResultRequest, node: AgentNode, db: DB):
    result = await db.execute(
        select(Task).where(Task.id == task_id, Task.node_id == node.id)
    )
    task = result.scalar_one_or_none()
    if not task:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Task not found")

    task.status = body.status
    task.result = body.result
    task.error = body.error
    task.finished_at = datetime.now(UTC)
    db.add(Event(
        node_id=node.id,
        severity="info" if body.status == "success" else "warning",
        type=f"task.{body.status}",
        message=f"Task {task.type} {body.status} on {node.name}",
        extra={"task_id": str(task.id), "type": task.type, "result": body.result, "error": body.error},
    ))
    await db.commit()
    await publish_event("tasks.changed", {"task_id": str(task.id), "node_id": str(node.id), "status": body.status, "type": task.type})


async def _assert_bot_runner(node: Node, db) -> None:
    bot_setting = await get_setting(db, TELEGRAM_BOT_SETTING_KEY)
    if str(bot_setting.get("runner_node_id", "")) != str(node.id):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not the designated bot runner")


@router.get("/bot/nodes")
async def bot_get_nodes(node: AgentNode, db: DB):
    await _assert_bot_runner(node, db)
    result = await db.execute(select(Node).order_by(Node.created_at.asc()))
    nodes = result.scalars().all()
    return [
        {
            "id": str(n.id),
            "name": n.name,
            "status": n.status,
            "hostname": n.hostname or "",
            "public_ip": n.public_ip or "",
        }
        for n in nodes
    ]


@router.get("/bot/alerts")
async def bot_get_alerts(node: AgentNode, db: DB):
    await _assert_bot_runner(node, db)
    stmt = (
        select(AlertIncident, AlertRule, Node)
        .join(AlertRule, AlertRule.id == AlertIncident.rule_id)
        .outerjoin(Node, Node.id == AlertIncident.node_id)
        .where(AlertIncident.resolved_at == None)  # noqa: E711
        .order_by(AlertIncident.started_at.desc())
        .limit(20)
    )
    rows = await db.execute(stmt)
    return [
        {
            "id": str(incident.id),
            "rule_name": rule.name,
            "node_name": n.name if n else None,
            "severity": rule.severity,
            "message": incident.message,
            "started_at": incident.started_at.isoformat(),
        }
        for incident, rule, n in rows.all()
    ]
