from pydantic import BaseModel


class EnrollRequest(BaseModel):
    enroll_token: str
    hostname: str
    public_ip: str | None = None
    os: str | None = None
    arch: str | None = None
    agent_version: str = "unknown"


class EnrollResponse(BaseModel):
    node_id: str
    agent_token: str
    config: dict


class HeartbeatRequest(BaseModel):
    agent_version: str = "unknown"
    status: str = "online"


class SnapshotMetrics(BaseModel):
    cpu_percent: float | None = None
    ram_used_mb: int | None = None
    ram_total_mb: int | None = None
    disk_used_gb: float | None = None
    disk_total_gb: float | None = None
    load_1: float | None = None
    load_5: float | None = None
    load_15: float | None = None
    network_rx_bytes: int | None = None
    network_tx_bytes: int | None = None


class SnapshotContainer(BaseModel):
    container_id: str
    name: str
    image: str | None = None
    status: str | None = None
    state: str | None = None
    ports: list = []
    networks: list = []
    mounts: list = []
    labels: dict = {}
    cpu_percent: float | None = None
    ram_mb: float | None = None
    restart_count: int | None = None
    health_status: str | None = None


class SnapshotPort(BaseModel):
    protocol: str
    port: int
    listen_ip: str | None = None
    process_name: str | None = None
    pid: int | None = None
    user_name: str | None = None
    container_name: str | None = None


class SnapshotRequest(BaseModel):
    metrics: SnapshotMetrics | None = None
    containers: list[SnapshotContainer] = []
    ports: list[SnapshotPort] = []


class TaskOut(BaseModel):
    id: str
    type: str
    payload: dict


class TaskResultRequest(BaseModel):
    status: str  # success | failed
    result: dict | None = None
    error: str | None = None
