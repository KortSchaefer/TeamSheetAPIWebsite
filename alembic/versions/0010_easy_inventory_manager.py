"""easy inventory manager idempotency

Revision ID: 0010_easy_inventory_manager
Revises: 0009_store_blast_threshold
Create Date: 2026-08-10
"""

from collections.abc import Sequence

from alembic import op

from app import models  # noqa: F401
from app.database import Base


revision: str = "0010_easy_inventory_manager"
down_revision: str | None = "0009_store_blast_threshold"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    Base.metadata.tables["inventory_easy_manager_commits"].create(
        bind=op.get_bind(), checkfirst=True
    )


def downgrade() -> None:
    Base.metadata.tables["inventory_easy_manager_commits"].drop(
        bind=op.get_bind(), checkfirst=True
    )
