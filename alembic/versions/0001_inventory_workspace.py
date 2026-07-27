"""Add inventory workspace tables and ledger compatibility columns."""

from alembic import op
from sqlalchemy import Column, Date, Integer, String, inspect

from app.database import Base
from app import models  # noqa: F401

revision = "0001_inventory_workspace"
down_revision = None
branch_labels = None
depends_on = None


def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    table_names = set(inspector.get_table_names())
    if "stock_movements" in table_names:
        columns = {column["name"] for column in inspector.get_columns("stock_movements")}
        additions = {
            "inventory_item_id": Integer,
            "location_id": Integer,
            "source_event_key": String(255),
            "lot_number": String(100),
            "expiration_date": Date,
            "created_by_user_id": Integer,
        }
        for name, column_type in additions.items():
            if name not in columns:
                op.add_column("stock_movements", Column(name, column_type, nullable=True))
    Base.metadata.create_all(bind=bind)


def downgrade():
    pass
