"""operations features: alerts, audit, rbac

Revision ID: 003
Revises: 002
Create Date: 2026-04-25

"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "003"
down_revision: Union[str, None] = "002"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("users", sa.Column("role", sa.String(length=16), nullable=False, server_default="admin"))
    op.add_column(
        "nodes",
        sa.Column("capabilities", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="[]"),
    )
    op.alter_column("nodes", "capabilities", server_default=None)

    op.create_table(
        "alert_rules",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("kind", sa.String(length=64), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("severity", sa.String(length=16), nullable=False, server_default="warning"),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("threshold", sa.Float(), nullable=True),
        sa.Column("duration_seconds", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("filters", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.UniqueConstraint("kind"),
    )

    op.create_table(
        "alert_incidents",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("rule_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("alert_rules.id", ondelete="CASCADE"), nullable=False),
        sa.Column("node_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("nodes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("status", sa.String(length=24), nullable=False, server_default="open"),
        sa.Column("message", sa.Text(), nullable=False),
        sa.Column("current_value", sa.Float(), nullable=True),
        sa.Column("extra", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"),
        sa.Column("started_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("acknowledged_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("acknowledged_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("silenced_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_alert_incidents_rule_id", "alert_incidents", ["rule_id"])
    op.create_index("ix_alert_incidents_node_id", "alert_incidents", ["node_id"])
    op.create_index(
        "uq_alert_incidents_active_rule_node",
        "alert_incidents",
        ["rule_id", "node_id"],
        unique=True,
        postgresql_where=sa.text("resolved_at IS NULL"),
    )

    op.create_table(
        "alert_channels",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(length=128), nullable=False),
        sa.Column("type", sa.String(length=32), nullable=False),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("severities", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default='["critical","warning"]'),
        sa.Column("send_resolved", sa.Boolean(), nullable=False, server_default=sa.text("true")),
        sa.Column("config", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )

    op.create_table(
        "audit_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
        sa.Column("node_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("nodes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("action", sa.String(length=128), nullable=False),
        sa.Column("target_type", sa.String(length=64), nullable=True),
        sa.Column("target_id", sa.String(length=128), nullable=True),
        sa.Column("message", sa.Text(), nullable=True),
        sa.Column("details", postgresql.JSONB(astext_type=sa.Text()), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.text("now()")),
    )
    op.create_index("ix_audit_logs_actor_user_id", "audit_logs", ["actor_user_id"])
    op.create_index("ix_audit_logs_node_id", "audit_logs", ["node_id"])
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])
    op.create_index("ix_audit_logs_target_type", "audit_logs", ["target_type"])
    op.create_index("ix_audit_logs_target_id", "audit_logs", ["target_id"])

    now = datetime.now(timezone.utc)
    rules = sa.table(
        "alert_rules",
        sa.column("id", postgresql.UUID(as_uuid=True)),
        sa.column("name", sa.String()),
        sa.column("kind", sa.String()),
        sa.column("description", sa.Text()),
        sa.column("severity", sa.String()),
        sa.column("enabled", sa.Boolean()),
        sa.column("threshold", sa.Float()),
        sa.column("duration_seconds", sa.Integer()),
        sa.column("filters", postgresql.JSONB(astext_type=sa.Text())),
        sa.column("created_at", sa.DateTime(timezone=True)),
        sa.column("updated_at", sa.DateTime(timezone=True)),
    )
    op.bulk_insert(
        rules,
        [
            {
                "id": uuid.uuid4(),
                "name": "Нода оффлайн",
                "kind": "node.offline",
                "description": "Нода не отвечает дольше заданного порога",
                "severity": "critical",
                "enabled": True,
                "threshold": None,
                "duration_seconds": 0,
                "filters": {},
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": uuid.uuid4(),
                "name": "CPU > 90%",
                "kind": "cpu.high",
                "description": "Высокая загрузка CPU на одной или нескольких нодах",
                "severity": "warning",
                "enabled": True,
                "threshold": 90.0,
                "duration_seconds": 0,
                "filters": {},
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": uuid.uuid4(),
                "name": "RAM > 85%",
                "kind": "ram.high",
                "description": "Оперативная память близка к пределу",
                "severity": "warning",
                "enabled": True,
                "threshold": 85.0,
                "duration_seconds": 0,
                "filters": {},
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": uuid.uuid4(),
                "name": "Диск > 80%",
                "kind": "disk.high",
                "description": "Свободное место заканчивается",
                "severity": "warning",
                "enabled": False,
                "threshold": 80.0,
                "duration_seconds": 0,
                "filters": {},
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": uuid.uuid4(),
                "name": "Новый открытый порт",
                "kind": "port.unexpected",
                "description": "Появился порт, который ещё не отмечен как ожидаемый",
                "severity": "warning",
                "enabled": True,
                "threshold": 1.0,
                "duration_seconds": 0,
                "filters": {},
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": uuid.uuid4(),
                "name": "Контейнер остановлен",
                "kind": "container.down",
                "description": "Docker-контейнер не находится в состоянии running",
                "severity": "warning",
                "enabled": True,
                "threshold": 1.0,
                "duration_seconds": 0,
                "filters": {},
                "created_at": now,
                "updated_at": now,
            },
            {
                "id": uuid.uuid4(),
                "name": "Агент устарел",
                "kind": "agent.outdated",
                "description": "Доступна более новая версия агента",
                "severity": "info",
                "enabled": False,
                "threshold": None,
                "duration_seconds": 0,
                "filters": {},
                "created_at": now,
                "updated_at": now,
            },
        ],
    )


def downgrade() -> None:
    op.drop_index("ix_audit_logs_target_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_target_type", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_index("ix_audit_logs_node_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor_user_id", table_name="audit_logs")
    op.drop_table("audit_logs")

    op.drop_table("alert_channels")

    op.drop_index("uq_alert_incidents_active_rule_node", table_name="alert_incidents")
    op.drop_index("ix_alert_incidents_node_id", table_name="alert_incidents")
    op.drop_index("ix_alert_incidents_rule_id", table_name="alert_incidents")
    op.drop_table("alert_incidents")

    op.drop_table("alert_rules")

    op.drop_column("nodes", "capabilities")
    op.drop_column("users", "role")
