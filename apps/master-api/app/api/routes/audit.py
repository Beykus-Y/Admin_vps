from fastapi import APIRouter
from sqlalchemy import select

from app.api.deps import CurrentAdmin, DB
from app.db.models import AuditLog, Node, User
from app.schemas.audit import AuditLogOut

router = APIRouter(prefix="/audit", tags=["audit"])


@router.get("", response_model=list[AuditLogOut])
async def list_audit_logs(
    _: CurrentAdmin,
    db: DB,
    action: str | None = None,
    target_type: str | None = None,
    limit: int = 200,
):
    stmt = (
        select(AuditLog, User.username, Node.name)
        .outerjoin(User, User.id == AuditLog.actor_user_id)
        .outerjoin(Node, Node.id == AuditLog.node_id)
        .order_by(AuditLog.created_at.desc())
        .limit(min(max(limit, 1), 500))
    )
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if target_type:
        stmt = stmt.where(AuditLog.target_type == target_type)

    result = await db.execute(stmt)
    return [
        AuditLogOut(
            id=entry.id,
            actor_username=username,
            node_id=entry.node_id,
            node_name=node_name,
            action=entry.action,
            target_type=entry.target_type,
            target_id=entry.target_id,
            message=entry.message,
            details=entry.details or {},
            created_at=entry.created_at,
        )
        for entry, username, node_name in result.all()
    ]
