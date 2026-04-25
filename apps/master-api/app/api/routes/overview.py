from fastapi import APIRouter
from sqlalchemy import func, select

from app.api.deps import DB, CurrentUser
from app.db.models import DockerContainer, Event, Node

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

    events_result = await db.execute(
        select(Event)
        .where(Event.severity.in_(["warning", "critical"]))
        .order_by(Event.created_at.desc())
        .limit(20)
    )
    recent_events = events_result.scalars().all()

    return {
        "nodes": {"total": total, "online": online, "offline": offline, "pending": pending},
        "containers": {"total": len(containers), "running": running},
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
