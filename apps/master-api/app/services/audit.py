from __future__ import annotations

import uuid

from app.db.models import AuditLog, User


def serialize_actor(user: User | None) -> dict | None:
    if not user:
        return None
    return {"id": str(user.id), "username": user.username, "role": user.role}


async def log_action(
    db,
    *,
    user: User | None,
    action: str,
    target_type: str | None = None,
    target_id: str | None = None,
    node_id: uuid.UUID | None = None,
    message: str | None = None,
    details: dict | None = None,
) -> AuditLog:
    entry = AuditLog(
        actor_user_id=user.id if user else None,
        node_id=node_id,
        action=action,
        target_type=target_type,
        target_id=target_id,
        message=message,
        details=details or {},
    )
    db.add(entry)
    await db.flush()
    return entry
