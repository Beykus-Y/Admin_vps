"""node inventory details

Revision ID: 002
Revises: 001
Create Date: 2026-04-25

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "002"
down_revision: Union[str, None] = "001"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("nodes", sa.Column("uptime_seconds", sa.BigInteger(), nullable=True))
    op.add_column("nodes", sa.Column("kernel", sa.String(128), nullable=True))
    op.add_column("nodes", sa.Column("cpu_model", sa.String(256), nullable=True))
    op.add_column("nodes", sa.Column("cpu_cores", sa.Integer(), nullable=True))
    op.add_column(
        "nodes",
        sa.Column("local_ips", postgresql.JSONB(), nullable=False, server_default="[]"),
    )
    op.alter_column("nodes", "local_ips", server_default=None)


def downgrade() -> None:
    op.drop_column("nodes", "local_ips")
    op.drop_column("nodes", "cpu_cores")
    op.drop_column("nodes", "cpu_model")
    op.drop_column("nodes", "kernel")
    op.drop_column("nodes", "uptime_seconds")
