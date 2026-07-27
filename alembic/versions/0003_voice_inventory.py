"""Add hands-free inventory voice sessions and audit records."""

from alembic import op
from sqlalchemy import inspect

from app import models  # noqa: F401
from app.database import Base


revision = "0003_voice_inventory"
down_revision = "0002_ingredient_catalog"
branch_labels = None
depends_on = None


TABLES = (
    "inventory_voice_sessions",
    "inventory_voice_utterances",
    "inventory_voice_entries",
    "inventory_item_aliases",
    "inventory_voice_session_counts",
)


def upgrade():
    bind = op.get_bind()
    for table_name in TABLES:
        Base.metadata.tables[table_name].create(bind=bind, checkfirst=True)


def downgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    existing = set(inspector.get_table_names())
    for table_name in reversed(TABLES):
        if table_name in existing:
            op.drop_table(table_name)
