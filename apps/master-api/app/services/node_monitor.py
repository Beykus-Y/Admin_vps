import asyncio
import time
from datetime import UTC, datetime, timedelta

from app.core.config import settings
from app.db.base import AsyncSessionLocal
from app.db.models import Event, Node, Task
from app.services.agent_releases import build_agent_update_payload, is_agent_outdated
from app.services.alerts import evaluate_offline_alert, evaluate_rule, get_rules_by_kind, list_notification_channels, notification_payload
from app.services.app_settings import create_bot_notification_task
from app.services.notifications import dispatch_channels
from app.services.realtime import publish_event
from sqlalchemy import select

_last_agent_update_check = 0.0


async def mark_offline_nodes() -> None:
    threshold = datetime.now(UTC) - timedelta(seconds=settings.node_offline_threshold_seconds)
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Node).where(Node.status == "online", Node.last_seen_at < threshold)
        )
        stale = result.scalars().all()
        notifications = []
        for node in stale:
            node.status = "offline"
            db.add(Event(
                node_id=node.id,
                severity="critical",
                type="node.offline",
                message=f"Node {node.name} went offline (last seen: {node.last_seen_at})",
            ))
            notifications.extend(await evaluate_offline_alert(db, node=node, active=True))
        if stale:
            for envelope in notifications:
                await create_bot_notification_task(db, notification_payload(envelope))
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
            for node in stale:
                await publish_event("inventory.changed", {"node_id": str(node.id), "status": "offline"})


async def schedule_agent_auto_updates() -> None:
    global _last_agent_update_check
    if not settings.agent_auto_update_enabled:
        return

    now_monotonic = time.monotonic()
    if now_monotonic - _last_agent_update_check < settings.agent_auto_update_check_seconds:
        return
    _last_agent_update_check = now_monotonic

    payload_by_arch = {
        "amd64": await build_agent_update_payload("amd64"),
        "arm64": await build_agent_update_payload("arm64"),
    }
    latest_version = payload_by_arch["amd64"].get("version")

    async with AsyncSessionLocal() as db:
        rules = await get_rules_by_kind(db)
        result = await db.execute(select(Node).where(Node.status == "online").order_by(Node.last_seen_at.desc()))
        nodes = result.scalars().all()
        scheduled = 0
        notifications = []
        for node in nodes:
            notifications.extend(
                await evaluate_rule(
                    db,
                    rule=rules.get("agent.outdated"),
                    node=node,
                    active=is_agent_outdated(node.agent_version, latest_version),
                    message=f"Agent on {node.name} is outdated ({node.agent_version} < {latest_version})",
                    extra={"current_version": node.agent_version, "latest_version": latest_version},
                )
            )
            if scheduled >= settings.agent_auto_update_batch_size:
                break
            if not is_agent_outdated(node.agent_version, latest_version):
                continue

            existing_result = await db.execute(
                select(Task.id).where(
                    Task.node_id == node.id,
                    Task.type == "agent.update",
                    Task.status.in_(["pending", "running"]),
                )
            )
            if existing_result.scalar_one_or_none():
                continue

            arch = "arm64" if node.arch and "arm" in node.arch.lower() else "amd64"
            payload = payload_by_arch[arch]
            db.add(Task(node_id=node.id, type="agent.update", payload=payload))
            db.add(Event(
                node_id=node.id,
                severity="info",
                type="agent.auto_update_scheduled",
                message=f"Agent auto-update to {payload.get('version')} ({arch}) scheduled",
                extra={"version": payload.get("version"), "arch": arch},
            ))
            scheduled += 1

        if scheduled or notifications:
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
        if scheduled:
            await publish_event("tasks.changed", {"type": "agent.update", "count": scheduled})


async def run_monitor() -> None:
    while True:
        try:
            await mark_offline_nodes()
            await schedule_agent_auto_updates()
        except Exception as e:
            print(f"[monitor] error: {e}")
        await asyncio.sleep(15)
