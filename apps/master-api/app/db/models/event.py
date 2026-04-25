import uuid

from sqlalchemy import ForeignKey, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models.base import Base, TimestampMixin, UUIDMixin


class Event(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "events"

    node_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("nodes.id", ondelete="SET NULL"), index=True)
    severity: Mapped[str] = mapped_column(String(16), nullable=False)  # info | warning | critical
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    message: Mapped[str] = mapped_column(Text, nullable=False)
    extra: Mapped[dict] = mapped_column(JSONB, default=dict)
