from datetime import UTC, datetime, timedelta

from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import DB, CurrentUser
from app.core.config import settings
from app.db.models import DockerContainer, Event, Node, OpenPort
from app.services.events import is_noisy_port_event

router = APIRouter(prefix="/overview", tags=["overview"])


@router.get("")
async def get_overview(_: CurrentUser, db: DB):
    nodes_result = await db.execute(select(Node))
    nodes = nodes_result.scalars().all()

    total = len(nodes)
    online = sum(1 for n in nodes if n.status == "online")
    offline = sum(1 for n in nodes if n.status == "offline")
    pending = sum(1 for n in nodes if n.status == "pending")

    containers_result = await db.execute(select(DockerContainer))
    containers = containers_result.scalars().all()
    running = sum(1 for c in containers if c.state == "running")

    ports_result = await db.execute(select(OpenPort))
    all_ports = ports_result.scalars().all()
    online_node_ids = {node.id for node in nodes if node.status == "online"}
    fresh_after = datetime.now(UTC) - timedelta(seconds=max(settings.node_offline_threshold_seconds * 2, 90))
    ports = [p for p in all_ports if p.node_id in online_node_ids and p.last_seen_at and p.last_seen_at >= fresh_after]
    unexpected_ports = sum(1 for p in ports if not p.is_expected)

    events_result = await db.execute(
        select(Event)
        .where(Event.severity.in_(["warning", "critical"]))
        .order_by(Event.created_at.desc())
        .limit(100)
    )
    recent_events = [e for e in events_result.scalars().all() if not is_noisy_port_event(e)][:20]

    return {
        "nodes": {"total": total, "online": online, "offline": offline, "pending": pending},
        "containers": {"total": len(containers), "running": running},
        "ports": {"total": len(ports), "unexpected": unexpected_ports},
        "recent_events": [
            {
                "id": str(e.id),
                "node_id": str(e.node_id) if e.node_id else None,
                "severity": e.severity,
                "type": e.type,
                "message": e.message,
                "created_at": e.created_at.isoformat(),
            }
            for e in recent_events
        ],
    }
