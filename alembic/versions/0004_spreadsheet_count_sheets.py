"""Add spreadsheet count-sheet metadata, templates, and row review state."""

from alembic import op
import sqlalchemy as sa
from sqlalchemy import inspect

from app import models  # noqa: F401
from app.database import Base


revision = "0004_spreadsheet_count_sheets"
down_revision = "0003_voice_inventory"
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
    Base.metadata.tables["inventory_count_templates"].create(
        bind=bind, checkfirst=True
    )
    _add_missing_columns(
        "inventory_counts",
        {
            "template_id": sa.Column(
                "template_id",
                sa.Integer(),
                sa.ForeignKey("inventory_count_templates.id"),
                nullable=True,
            ),
            "revision": sa.Column(
                "revision", sa.Integer(), nullable=False, server_default="1"
            ),
            "approved_at": sa.Column(
                "approved_at", sa.DateTime(timezone=True), nullable=True
            ),
        },
    )
    _add_missing_columns(
        "inventory_count_lines",
        {
            "display_order": sa.Column(
                "display_order", sa.Integer(), nullable=False, server_default="0"
            ),
            "is_counted": sa.Column(
                "is_counted",
                sa.Boolean(),
                nullable=False,
                server_default=sa.true(),
            ),
            "source": sa.Column("source", sa.String(20), nullable=True),
            "confidence": sa.Column("confidence", sa.Float(), nullable=True),
            "review_status": sa.Column(
                "review_status",
                sa.String(30),
                nullable=False,
                server_default="READY",
            ),
            "evidence": sa.Column("evidence", sa.Text(), nullable=True),
            "revision": sa.Column(
                "revision", sa.Integer(), nullable=False, server_default="1"
            ),
            "updated_by_user_id": sa.Column(
                "updated_by_user_id",
                sa.Integer(),
                sa.ForeignKey("users.id"),
                nullable=True,
            ),
        },
    )
    Base.metadata.tables["inventory_count_template_lines"].create(
        bind=bind, checkfirst=True
    )


def downgrade():
    bind = op.get_bind()
    existing = set(inspect(bind).get_table_names())
    if "inventory_count_template_lines" in existing:
        op.drop_table("inventory_count_template_lines")
    if "inventory_count_templates" in existing:
        op.drop_table("inventory_count_templates")
