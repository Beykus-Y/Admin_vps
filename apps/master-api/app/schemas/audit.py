import uuid
from datetime import datetime

from pydantic import BaseModel


class AuditLogOut(BaseModel):
    id: uuid.UUID
    actor_username: str | None
    node_id: uuid.UUID | None
    node_name: str | None
    action: str
    target_type: str | None
    target_id: str | None
    message: str | None
    details: dict
    created_at: datetime
