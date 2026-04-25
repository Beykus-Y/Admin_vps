import asyncio
from datetime import UTC, datetime, timedelta

from app.core.config import settings
from app.db.base import AsyncSessionLocal
from app.db.models import Event, Node
from sqlalchemy import select


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


async def run_monitor() -> None:
    while True:
        try:
            await mark_offline_nodes()
        except Exception as e:
            print(f"[monitor] error: {e}")
        await asyncio.sleep(15)
