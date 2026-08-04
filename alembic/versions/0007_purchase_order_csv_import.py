"""Add CSV import metadata to purchase orders."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect


revision = "0007_purchase_order_csv_import"
down_revision = "0006_repair_pos_table_request_id"
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    table = "inventory_purchase_orders"
    if table not in inspector.get_table_names():
        return

    columns = {column["name"] for column in inspector.get_columns(table)}
    additions = {
        "external_reference": sa.Column("external_reference", sa.String(length=100), nullable=True),
        "import_source_hash": sa.Column("import_source_hash", sa.String(length=64), nullable=True),
        "imported_filename": sa.Column("imported_filename", sa.String(length=255), nullable=True),
    }
    for name, column in additions.items():
        if name not in columns:
            op.add_column(table, column)

    inspector = inspect(bind)
    indexes = {index["name"] for index in inspector.get_indexes(table)}
    if "ix_inventory_purchase_orders_import_source_hash" not in indexes:
        op.create_index(
            "ix_inventory_purchase_orders_import_source_hash",
            table,
            ["import_source_hash"],
            unique=True,
        )
    if "uq_purchase_order_vendor_reference" not in indexes:
        op.create_index(
            "uq_purchase_order_vendor_reference",
            table,
            ["vendor_id", "external_reference"],
            unique=True,
        )


def downgrade():
    # Keep the repair-style migration safe for SQLite installations that may have
    # received these columns through the startup compatibility hook.
    pass
