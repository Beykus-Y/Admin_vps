import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Integer, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db.models.base import Base, TimestampMixin, UUIDMixin


class Node(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "nodes"

    name: Mapped[str] = mapped_column(String(128), nullable=False)
    status: Mapped[str] = mapped_column(String(32), default="pending")  # pending | online | offline
    hostname: Mapped[str | None] = mapped_column(String(256))
    public_ip: Mapped[str | None] = mapped_column(String(64))
    os: Mapped[str | None] = mapped_column(String(128))
    arch: Mapped[str | None] = mapped_column(String(32))
    uptime_seconds: Mapped[int | None] = mapped_column(BigInteger)
    kernel: Mapped[str | None] = mapped_column(String(128))
    cpu_model: Mapped[str | None] = mapped_column(String(256))
    cpu_cores: Mapped[int | None] = mapped_column(Integer)
    local_ips: Mapped[list] = mapped_column(JSONB, default=list)
    provider: Mapped[str | None] = mapped_column(String(64))
    location: Mapped[str | None] = mapped_column(String(64))
    group_name: Mapped[str | None] = mapped_column(String(64))
    tags: Mapped[list] = mapped_column(JSONB, default=list)
    agent_version: Mapped[str | None] = mapped_column(String(32))
    capabilities: Mapped[list] = mapped_column(JSONB, default=list)
    last_seen_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    enroll_tokens: Mapped[list["NodeEnrollToken"]] = relationship(back_populates="node", cascade="all, delete-orphan")
    credentials: Mapped[list["NodeCredential"]] = relationship(back_populates="node", cascade="all, delete-orphan")


class NodeEnrollToken(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "node_enroll_tokens"

    node_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    node: Mapped["Node"] = relationship(back_populates="enroll_tokens")


class NodeCredential(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "node_credentials"

    node_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False)
    token_hash: Mapped[str] = mapped_column(Text, nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    node: Mapped["Node"] = relationship(back_populates="credentials")
