import asyncio
import time
from datetime import UTC, datetime, timedelta

from app.core.config import settings
from app.db.base import AsyncSessionLocal
from app.db.models import Event, Node, Task
from app.services.agent_releases import build_agent_update_payload, is_agent_outdated
from sqlalchemy import select

_last_agent_update_check = 0.0


async def mark_offline_nodes() -> None:
    threshold = datetime.now(UTC) - timedelta(seconds=settings.node_offline_threshold_seconds)
    async with AsyncSessionLocal() as db:
        result = await db.execute(
            select(Node).where(Node.status == "online", Node.last_seen_at < threshold)
        )
        stale = result.scalars().all()
        for node in stale:
            node.status = "offline"
            db.add(Event(
                node_id=node.id,
                severity="critical",
                type="node.offline",
                message=f"Node {node.name} went offline (last seen: {node.last_seen_at})",
            ))
        if stale:
            await db.commit()


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
        result = await db.execute(select(Node).where(Node.status == "online").order_by(Node.last_seen_at.desc()))
        nodes = result.scalars().all()
        scheduled = 0
        for node in nodes:
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

        if scheduled:
            await db.commit()


async def run_monitor() -> None:
    while True:
        try:
            await mark_offline_nodes()
            await schedule_agent_auto_updates()
        except Exception as e:
            print(f"[monitor] error: {e}")
        await asyncio.sleep(15)
