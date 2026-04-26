"""alert debounce: resolve_for_seconds + apply sensible defaults

Revision ID: 005
Revises: 004
Create Date: 2026-04-27

"""
from __future__ import annotations

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "005"
down_revision: Union[str, None] = "004"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "alert_rules",
        sa.Column("resolve_for_seconds", sa.Integer(), nullable=False, server_default="0"),
    )

    # Apply debounce defaults to existing rules created before this migration
    op.execute(
        "UPDATE alert_rules SET duration_seconds = 120, resolve_for_seconds = 300"
        " WHERE kind IN ('cpu.high', 'ram.high') AND duration_seconds = 0"
    )
    op.execute(
        "UPDATE alert_rules SET duration_seconds = 60"
        " WHERE kind = 'container.down' AND duration_seconds = 0"
    )


def downgrade() -> None:
    op.drop_column("alert_rules", "resolve_for_seconds")
