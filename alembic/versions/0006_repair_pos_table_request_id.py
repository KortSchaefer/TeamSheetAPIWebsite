"""Repair POS tables created before client request id was added."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

from app import models  # noqa: F401
from app.database import Base


revision = "0006_repair_pos_table_request_id"
down_revision = "0005_pos_terminal_v1"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    if "pos_tables" not in inspector.get_table_names():
        Base.metadata.tables["pos_tables"].create(bind=bind, checkfirst=True)
        return

    columns = {column["name"] for column in inspector.get_columns("pos_tables")}
    if "client_request_id" not in columns:
        op.add_column(
            "pos_tables",
            sa.Column("client_request_id", sa.String(length=64), nullable=True),
        )

    inspector = inspect(bind)
    indexes = {index["name"] for index in inspector.get_indexes("pos_tables")}
    if "ix_pos_tables_client_request_id" not in indexes:
        op.create_index(
            "ix_pos_tables_client_request_id",
            "pos_tables",
            ["client_request_id"],
            unique=True,
        )


def downgrade():
    # Migration 0005's intended schema already includes this column and index.
    # Removing either would recreate the drift this repair corrects.
    pass
