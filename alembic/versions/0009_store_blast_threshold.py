"""Add the configurable TeamSheet BLAST minimum to store preferences."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "0009_store_blast_threshold"
down_revision = "0008_inventory_planning"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    table = "store_preferences"
    if table not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns(table)}
    if "blast_minimum_percent" not in columns:
        op.add_column(
            table,
            sa.Column(
                "blast_minimum_percent",
                sa.Float(),
                nullable=False,
                server_default="98",
            ),
        )


def downgrade():
    # Keep the compatibility column for SQLite installations using startup repair.
    pass
