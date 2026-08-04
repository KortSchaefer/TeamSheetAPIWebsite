"""Add POS terminal credentials, sessions, tables, checks, and audit events."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

from app import models  # noqa: F401
from app.database import Base


revision = "0005_pos_terminal_v1"
down_revision = "0004_spreadsheet_count_sheets"
branch_labels = None
depends_on = None


def _add_missing_columns(table_name, additions):
    bind = op.get_bind()
    existing = {
        column["name"] for column in inspect(bind).get_columns(table_name)
    }
    for name, column in additions.items():
        if name not in existing:
            op.add_column(table_name, column)


def upgrade():
    bind = op.get_bind()
    Base.metadata.tables["pos_credentials"].create(bind=bind, checkfirst=True)
    Base.metadata.tables["pos_terminal_sessions"].create(bind=bind, checkfirst=True)
    Base.metadata.tables["pos_tables"].create(bind=bind, checkfirst=True)

    _add_missing_columns(
        "menu_categories",
        {
            "display_order": sa.Column(
                "display_order", sa.Integer(), nullable=False, server_default="0"
            ),
        },
    )
    _add_missing_columns(
        "pos_orders",
        {
            "table_id": sa.Column(
                "table_id",
                sa.Integer(),
                sa.ForeignKey("pos_tables.id"),
                nullable=True,
            ),
            "check_number": sa.Column(
                "check_number", sa.Integer(), nullable=False, server_default="1"
            ),
            "progress": sa.Column(
                "progress",
                sa.String(30),
                nullable=False,
                server_default="FOOD_UNORDERED",
            ),
            "subtotal_cents": sa.Column(
                "subtotal_cents", sa.Integer(), nullable=False, server_default="0"
            ),
            "tax_cents": sa.Column(
                "tax_cents", sa.Integer(), nullable=False, server_default="0"
            ),
            "tip_cents": sa.Column(
                "tip_cents", sa.Integer(), nullable=False, server_default="0"
            ),
            "total_cents": sa.Column(
                "total_cents", sa.Integer(), nullable=False, server_default="0"
            ),
            "print_count": sa.Column(
                "print_count", sa.Integer(), nullable=False, server_default="0"
            ),
            "printed_at": sa.Column(
                "printed_at", sa.DateTime(timezone=True), nullable=True
            ),
            "closed_at": sa.Column(
                "closed_at", sa.DateTime(timezone=True), nullable=True
            ),
        },
    )
    existing_order_indexes = {
        index["name"] for index in inspect(bind).get_indexes("pos_orders")
    }
    if "ix_pos_orders_table_id" not in existing_order_indexes:
        op.create_index(
            "ix_pos_orders_table_id",
            "pos_orders",
            ["table_id"],
            unique=False,
        )
    Base.metadata.tables["pos_table_events"].create(bind=bind, checkfirst=True)

    categories = [
        "Drinks",
        "Apps",
        "Apps as Meal",
        "Salads",
        "Steaks",
        "Chicken",
        "Ribs",
        "Combos",
        "Prime",
        "Special",
        "Seafood",
    ]
    category_table = Base.metadata.tables["menu_categories"]
    for index, name in enumerate(categories, start=1):
        exists = bind.execute(
            sa.select(category_table.c.id).where(category_table.c.name == name)
        ).first()
        if exists:
            bind.execute(
                category_table.update()
                .where(category_table.c.name == name)
                .values(display_order=index, active=True)
            )
        else:
            bind.execute(
                category_table.insert().values(
                    name=name,
                    description="POS V1 category",
                    active=True,
                    display_order=index,
                )
            )


def downgrade():
    bind = op.get_bind()
    existing = set(inspect(bind).get_table_names())
    for table_name in (
        "pos_table_events",
        "pos_terminal_sessions",
        "pos_credentials",
        "pos_tables",
    ):
        if table_name in existing:
            op.drop_table(table_name)
