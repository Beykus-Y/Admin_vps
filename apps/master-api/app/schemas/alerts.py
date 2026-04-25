import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class AlertRuleOut(BaseModel):
    id: uuid.UUID
    name: str
    kind: str
    description: str | None
    severity: str
    enabled: bool
    threshold: float | None
    duration_seconds: int
    filters: dict
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AlertRuleUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    severity: str | None = None
    enabled: bool | None = None
    threshold: float | None = None
    duration_seconds: int | None = None
    filters: dict | None = None


class AlertIncidentOut(BaseModel):
    id: uuid.UUID
    rule_id: uuid.UUID
    rule_name: str
    rule_kind: str
    node_id: uuid.UUID | None
    node_name: str | None
    severity: str
    status: str
    message: str
    current_value: float | None
    extra: dict
    started_at: datetime
    last_seen_at: datetime
    acknowledged_at: datetime | None
    acknowledged_by: str | None
    silenced_until: datetime | None
    resolved_at: datetime | None


class AlertIncidentSilenceRequest(BaseModel):
    minutes: int = 60


class AlertChannelBase(BaseModel):
    name: str
    type: str
    enabled: bool = True
    severities: list[str] = Field(default_factory=lambda: ["critical", "warning"])
    send_resolved: bool = True
    config: dict = Field(default_factory=dict)


class AlertChannelCreate(AlertChannelBase):
    pass


class AlertChannelUpdate(BaseModel):
    name: str | None = None
    type: str | None = None
    enabled: bool | None = None
    severities: list[str] | None = None
    send_resolved: bool | None = None
    config: dict | None = None


class AlertChannelOut(AlertChannelBase):
    id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}
