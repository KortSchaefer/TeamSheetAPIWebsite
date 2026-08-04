"""Add weekday stock targets and purchase-order planning metadata."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

from app import models  # noqa: F401
from app.database import Base


revision = "0008_inventory_planning"
down_revision = "0007_purchase_order_csv_import"
branch_labels = None
depends_on = None


def _add_columns(table: str, additions: dict[str, sa.Column]) -> None:
    bind = op.get_bind()
    inspector = inspect(bind)
    if table not in inspector.get_table_names():
        return
    columns = {column["name"] for column in inspector.get_columns(table)}
    for name, column in additions.items():
        if name not in columns:
            op.add_column(table, column)


def upgrade():
    bind = op.get_bind()
    Base.metadata.tables["inventory_weekday_targets"].create(bind=bind, checkfirst=True)

    _add_columns(
        "inventory_balances",
        {
            "planning_active": sa.Column(
                "planning_active", sa.Boolean(), nullable=False, server_default=sa.true()
            ),
            "lower_tolerance_percent": sa.Column(
                "lower_tolerance_percent", sa.Numeric(6, 2), nullable=True
            ),
            "upper_tolerance_percent": sa.Column(
                "upper_tolerance_percent", sa.Numeric(6, 2), nullable=True
            ),
        },
    )
    _add_columns(
        "inventory_purchase_order_lines",
        {
            "location_id": sa.Column("location_id", sa.Integer(), nullable=True),
            "purchase_unit": sa.Column("purchase_unit", sa.String(length=30), nullable=True),
            "quantity_per_purchase_unit": sa.Column(
                "quantity_per_purchase_unit",
                sa.Numeric(12, 4),
                nullable=False,
                server_default="1",
            ),
        },
    )
    _add_columns(
        "inventory_receiving_lines",
        {
            "purchase_order_line_id": sa.Column(
                "purchase_order_line_id", sa.Integer(), nullable=True
            )
        },
    )

    inspector = inspect(bind)
    order_indexes = {
        index["name"] for index in inspector.get_indexes("inventory_purchase_order_lines")
    }
    if "ix_inventory_purchase_order_lines_location_id" not in order_indexes:
        op.create_index(
            "ix_inventory_purchase_order_lines_location_id",
            "inventory_purchase_order_lines",
            ["location_id"],
        )
    receiving_indexes = {
        index["name"] for index in inspect(bind).get_indexes("inventory_receiving_lines")
    }
    if "ix_inventory_receiving_lines_purchase_order_line_id" not in receiving_indexes:
        op.create_index(
            "ix_inventory_receiving_lines_purchase_order_line_id",
            "inventory_receiving_lines",
            ["purchase_order_line_id"],
        )

    target = Base.metadata.tables["inventory_weekday_targets"]
    balances = Base.metadata.tables["inventory_balances"]
    for weekday in range(7):
        existing = sa.select(target.c.id).where(
            target.c.inventory_item_id == balances.c.inventory_item_id,
            target.c.location_id == balances.c.location_id,
            target.c.weekday == weekday,
        )
        bind.execute(
            target.insert().from_select(
                [
                    "inventory_item_id",
                    "location_id",
                    "weekday",
                    "target_quantity",
                    "created_at",
                    "updated_at",
                ],
                sa.select(
                    balances.c.inventory_item_id,
                    balances.c.location_id,
                    sa.literal(weekday),
                    balances.c.par_quantity,
                    sa.func.current_timestamp(),
                    sa.func.current_timestamp(),
                ).where(balances.c.par_quantity > 0, ~sa.exists(existing)),
            )
        )


def downgrade():
    # Preserve compatibility data on SQLite installations that use startup repair hooks.
    pass
