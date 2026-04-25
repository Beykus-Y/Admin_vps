import uuid
from datetime import datetime

from pydantic import BaseModel


class TaskCreate(BaseModel):
    type: str
    payload: dict = {}


ALLOWED_TASK_TYPES = {
    "container.restart",
    "container.stop",
    "container.start",
    "container.logs",
    "service.restart",
    "docker.compose.pull",
    "docker.compose.up",
    "docker.compose.down",
    "system.reboot",
    "agent.update",
}


class TaskOutFull(BaseModel):
    id: uuid.UUID
    node_id: uuid.UUID
    type: str
    payload: dict
    status: str
    result: dict | None
    error: str | None
    created_at: datetime
    started_at: datetime | None
    finished_at: datetime | None

    model_config = {"from_attributes": True}
