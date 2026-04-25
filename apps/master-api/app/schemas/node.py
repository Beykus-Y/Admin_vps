import uuid
from datetime import datetime

from pydantic import BaseModel


class NodeCreate(BaseModel):
    name: str
    provider: str | None = None
    location: str | None = None
    group_name: str | None = None
    tags: list[str] = []


class NodeOut(BaseModel):
    id: uuid.UUID
    name: str
    status: str
    hostname: str | None
    public_ip: str | None
    os: str | None
    arch: str | None
    provider: str | None
    location: str | None
    group_name: str | None
    tags: list
    agent_version: str | None
    created_at: datetime
    last_seen_at: datetime | None

    model_config = {"from_attributes": True}


class NodeEnrollTokenOut(BaseModel):
    install_command: str
    enroll_token: str
    expires_at: datetime
