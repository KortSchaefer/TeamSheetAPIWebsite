"""AGM floor and host-stand domain

Revision ID: 0011_agm_floor
Revises: 0010_easy_inventory_manager
Create Date: 2026-08-10
"""

from collections.abc import Sequence

from alembic import op

from app import models  # noqa: F401
from app.database import Base


revision: str = "0011_agm_floor"
down_revision: str | None = "0010_easy_inventory_manager"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = [
    "agm_stores",
    "agm_store_memberships",
    "agm_layouts",
    "agm_table_definitions",
    "agm_services",
    "agm_parties",
    "agm_table_states",
    "agm_server_rotations",
    "agm_events",
    "agm_sms_outbox",
]


def upgrade() -> None:
    bind = op.get_bind()
    for name in TABLES:
        Base.metadata.tables[name].create(bind=bind, checkfirst=True)
    op.execute(
        """
        INSERT INTO agm_stores (store_number, name, timezone, active, created_at, updated_at)
        SELECT '1', 'Restaurant 1', 'America/Chicago', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        WHERE NOT EXISTS (SELECT 1 FROM agm_stores WHERE store_number = '1')
        """
    )
    op.execute(
        """
        INSERT INTO agm_store_memberships
          (store_id, user_id, access_role, active, created_at, updated_at)
        SELECT s.id, u.id, CASE WHEN u.role = 'ADMIN' THEN 'ADMIN' ELSE 'AGM' END,
               1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        FROM users u CROSS JOIN agm_stores s
        WHERE s.store_number = '1' AND u.role IN ('ADMIN', 'MANAGER')
          AND NOT EXISTS (
            SELECT 1 FROM agm_store_memberships m
            WHERE m.store_id = s.id AND m.user_id = u.id
          )
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    for name in reversed(TABLES):
        Base.metadata.tables[name].drop(bind=bind, checkfirst=True)
