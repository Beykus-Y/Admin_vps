from pydantic import BaseModel, Field


class EnrollRequest(BaseModel):
    enroll_token: str
    hostname: str
    public_ip: str | None = None
    os: str | None = None
    arch: str | None = None
    agent_version: str = "unknown"
    capabilities: list[str] = Field(default_factory=list)


class EnrollResponse(BaseModel):
    node_id: str
    agent_token: str
    config: dict


class HeartbeatRequest(BaseModel):
    agent_version: str = "unknown"
    status: str = "online"
    capabilities: list[str] = Field(default_factory=list)


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


class SnapshotSystem(BaseModel):
    hostname: str | None = None
    public_ip: str | None = None
    os: str | None = None
    arch: str | None = None
    uptime_seconds: int | None = None
    kernel: str | None = None
    cpu_model: str | None = None
    cpu_cores: int | None = None
    local_ips: list[str] = Field(default_factory=list)


class SnapshotContainer(BaseModel):
    container_id: str
    name: str
    image: str | None = None
    status: str | None = None
    state: str | None = None
    ports: list = Field(default_factory=list)
    networks: list = Field(default_factory=list)
    mounts: list = Field(default_factory=list)
    labels: dict = Field(default_factory=dict)
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
    system: SnapshotSystem | None = None
    metrics: SnapshotMetrics | None = None
    containers: list[SnapshotContainer] = Field(default_factory=list)
    ports: list[SnapshotPort] = Field(default_factory=list)
    containers_collected: bool = True
    ports_collected: bool = True
    errors: list[str] = Field(default_factory=list)
    capabilities: list[str] = Field(default_factory=list)


class TaskOut(BaseModel):
    id: str
    type: str
    payload: dict


class TaskResultRequest(BaseModel):
    status: str  # success | failed
    result: dict | None = None
    error: str | None = None


class HeartbeatBotConfig(BaseModel):
    bot_token: str
    allowed_chat_ids: list[int] = Field(default_factory=list)


class HeartbeatResponse(BaseModel):
    is_bot_runner: bool = False
    bot_config: HeartbeatBotConfig | None = None
