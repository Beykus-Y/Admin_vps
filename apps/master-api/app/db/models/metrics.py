import uuid

from sqlalchemy import BigInteger, Double, ForeignKey
from sqlalchemy.orm import Mapped, mapped_column

from app.db.models.base import Base, TimestampMixin, UUIDMixin


class NodeMetric(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "node_metrics"

    node_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("nodes.id", ondelete="CASCADE"), nullable=False, index=True)
    cpu_percent: Mapped[float | None] = mapped_column(Double)
    ram_used_mb: Mapped[int | None] = mapped_column(BigInteger)
    ram_total_mb: Mapped[int | None] = mapped_column(BigInteger)
    disk_used_gb: Mapped[float | None] = mapped_column(Double)
    disk_total_gb: Mapped[float | None] = mapped_column(Double)
    load_1: Mapped[float | None] = mapped_column(Double)
    load_5: Mapped[float | None] = mapped_column(Double)
    load_15: Mapped[float | None] = mapped_column(Double)
    network_rx_bytes: Mapped[int | None] = mapped_column(BigInteger)
    network_tx_bytes: Mapped[int | None] = mapped_column(BigInteger)
