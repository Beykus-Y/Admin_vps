import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class NodeCreate(BaseModel):
    name: str
    provider: str | None = None
    location: str | None = None
    group_name: str | None = None
    tags: list[str] = Field(default_factory=list)


class NodeOut(BaseModel):
    id: uuid.UUID
    name: str
    status: str
    hostname: str | None
    public_ip: str | None
    os: str | None
    arch: str | None
    uptime_seconds: int | None
    kernel: str | None
    cpu_model: str | None
    cpu_cores: int | None
    local_ips: list
    provider: str | None
    location: str | None
    group_name: str | None
    tags: list[str]
    agent_version: str | None
    capabilities: list[str]
    created_at: datetime
    last_seen_at: datetime | None

    model_config = {"from_attributes": True}


class NodeEnrollTokenOut(BaseModel):
    install_command: str
    enroll_token: str
    expires_at: datetime


class NodeMetricOut(BaseModel):
    id: uuid.UUID
    cpu_percent: float | None
    ram_used_mb: int | None
    ram_total_mb: int | None
    disk_used_gb: float | None
    disk_total_gb: float | None
    load_1: float | None
    load_5: float | None
    load_15: float | None
    network_rx_bytes: int | None
    network_tx_bytes: int | None
    created_at: datetime

    model_config = {"from_attributes": True}
