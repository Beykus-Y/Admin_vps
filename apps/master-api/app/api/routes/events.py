from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import CurrentUser, DB
from app.db.models import Event, Node
from app.services.events import is_noisy_port_event

router = APIRouter(prefix="/events", tags=["events"])


@router.get("")
async def list_events(
    _: CurrentUser,
    db: DB,
    severity: str | None = None,
    node_id: str | None = None,
    limit: int = 200,
):
    stmt = (
        select(Event, Node.name)
        .outerjoin(Node, Node.id == Event.node_id)
        .order_by(Event.created_at.desc())
        .limit(min(max(limit, 1), 500))
    )
    if severity:
        stmt = stmt.where(Event.severity == severity)
    if node_id:
        stmt = stmt.where(Event.node_id == node_id)

    result = await db.execute(stmt)
    rows = []
    for event, node_name in result.all():
        if is_noisy_port_event(event):
            continue
        rows.append(
            {
                "id": str(event.id),
                "node_id": str(event.node_id) if event.node_id else None,
                "node_name": node_name or "системное событие",
                "severity": event.severity,
                "type": event.type,
                "message": event.message,
                "extra": event.extra or {},
                "created_at": event.created_at.isoformat(),
            }
        )
    return rows
