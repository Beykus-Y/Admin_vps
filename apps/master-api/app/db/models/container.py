import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Double, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models.base import Base, UUIDMixin, utcnow


class DockerContainer(UUIDMixin, Base):
    __tablename__ = "docker_containers"
    __table_args__ = (UniqueConstraint("node_id", "container_id"),)

    node_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False, index=True)
    container_id: Mapped[str] = mapped_column(Text, nullable=False)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    image: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str | None] = mapped_column(String(64))
    state: Mapped[str | None] = mapped_column(String(64))
    ports: Mapped[list] = mapped_column(JSONB, default=list)
    networks: Mapped[list] = mapped_column(JSONB, default=list)
    mounts: Mapped[list] = mapped_column(JSONB, default=list)
    labels: Mapped[dict] = mapped_column(JSONB, default=dict)
    cpu_percent: Mapped[float | None] = mapped_column(Double)
    ram_mb: Mapped[float | None] = mapped_column(Double)
    restart_count: Mapped[int | None] = mapped_column(Integer)
    health_status: Mapped[str | None] = mapped_column(String(64))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow)
