"""POS button management and configuration

Revision ID: 0012_pos_button_management
Revises: 0011_agm_floor
Create Date: 2026-08-11
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

from app import models  # noqa: F401
from app.database import Base


revision: str = "0012_pos_button_management"
down_revision: str | None = "0011_agm_floor"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

TABLES = [
    "pos_pages",
    "pos_buttons",
    "pos_tags",
    "pos_button_tags",
    "pos_modifier_groups",
    "pos_modifiers",
    "pos_button_modifier_groups",
    "pos_tag_modifier_groups",
    "pos_prompts",
    "pos_button_prompts",
    "pos_tag_prompts",
    "pos_behavior_rules",
    "pos_config_audit",
]


def upgrade() -> None:
    bind = op.get_bind()
    inspector = sa.inspect(bind)
    recipe_columns = {column["name"] for column in inspector.get_columns("recipe_items")}
    if "selection_type" not in recipe_columns:
        op.add_column("recipe_items", sa.Column("selection_type", sa.String(20), nullable=False, server_default="INCLUDED"))
    if "display_order" not in recipe_columns:
        op.add_column("recipe_items", sa.Column("display_order", sa.Integer(), nullable=False, server_default="0"))

    order_item_columns = {column["name"] for column in inspector.get_columns("pos_order_items")}
    if "modifier_total_cents" not in order_item_columns:
        op.add_column("pos_order_items", sa.Column("modifier_total_cents", sa.Integer(), nullable=False, server_default="0"))
    if "display_name_snapshot" not in order_item_columns:
        op.add_column("pos_order_items", sa.Column("display_name_snapshot", sa.String(150)))
    if "configuration_snapshot" not in order_item_columns:
        op.add_column("pos_order_items", sa.Column("configuration_snapshot", sa.JSON()))

    for name in TABLES:
        Base.metadata.tables[name].create(bind=bind, checkfirst=True)


def downgrade() -> None:
    bind = op.get_bind()
    for name in reversed(TABLES):
        Base.metadata.tables[name].drop(bind=bind, checkfirst=True)
    with op.batch_alter_table("pos_order_items") as batch:
        batch.drop_column("configuration_snapshot")
        batch.drop_column("display_name_snapshot")
        batch.drop_column("modifier_total_cents")
    with op.batch_alter_table("recipe_items") as batch:
        batch.drop_column("display_order")
        batch.drop_column("selection_type")
