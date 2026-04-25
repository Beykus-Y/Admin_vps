from datetime import datetime

from pydantic import BaseModel

from app.schemas.node import NodeMetricOut, NodeOut


class InventoryContainerOut(BaseModel):
    id: str
    container_id: str
    name: str
    image: str | None
    status: str | None
    state: str | None
    ports: list[str]
    networks: list[str]
    mounts: list[str]
    cpu_percent: float | None
    ram_mb: float | None
    restart_count: int | None
    health_status: str | None
    updated_at: datetime | None


class InventoryPortOut(BaseModel):
    id: str
    protocol: str
    port: int
    listen_ip: str | None
    process_name: str | None
    pid: int | None
    user_name: str | None
    container_name: str | None
    is_expected: bool
    status: str
    first_seen_at: datetime | None
    last_seen_at: datetime | None


class InventoryNodeOut(BaseModel):
    node: NodeOut
    metrics: NodeMetricOut | None
    containers: list[InventoryContainerOut]
    ports: list[InventoryPortOut]
    incidents: list[dict]
    tasks_pending: int


class InventorySnapshotOut(BaseModel):
    nodes: list[InventoryNodeOut]
    recent_events: list[dict]
    summary: dict
