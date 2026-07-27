"""Add the normalized ingredient catalog and lineage graph."""

from alembic import op
from sqlalchemy import Boolean, Column, Integer, JSON, String, Text, inspect, text

from app.database import Base
from app import models  # noqa: F401


revision = "0002_ingredient_catalog"
down_revision = "0001_inventory_workspace"
branch_labels = None
depends_on = None


def _add_missing_columns(table_name, additions):
    bind = op.get_bind()
    inspector = inspect(bind)
    existing = {column["name"] for column in inspector.get_columns(table_name)}
    for name, column in additions.items():
        if name not in existing:
            op.add_column(table_name, column)


def upgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())

    if "ingredients" in tables:
        _add_missing_columns(
            "ingredients",
            {
                "external_id": Column("external_id", String(150), nullable=True),
                "normalized_name": Column("normalized_name", String(150), nullable=True),
                "category": Column("category", String(100), nullable=True),
                "stage": Column("stage", String(50), nullable=True),
                "process": Column("process", Text, nullable=True),
                "added_to_complete_lineage": Column(
                    "added_to_complete_lineage",
                    Boolean,
                    nullable=False,
                    server_default=text("0"),
                ),
                "source_correction": Column("source_correction", Text, nullable=True),
                "resolution_needed": Column("resolution_needed", Text, nullable=True),
                "catalog_schema_version": Column(
                    "catalog_schema_version", String(30), nullable=True
                ),
                "catalog_metadata": Column("catalog_metadata", JSON, nullable=True),
            },
        )

    if "inventory_items" in tables:
        _add_missing_columns(
            "inventory_items",
            {"ingredient_id": Column("ingredient_id", Integer, nullable=True)},
        )

    Base.metadata.tables["ingredient_catalog_imports"].create(bind=bind, checkfirst=True)
    Base.metadata.tables["ingredient_lineage"].create(bind=bind, checkfirst=True)

    inspector = inspect(bind)
    ingredient_indexes = {
        index["name"] for index in inspector.get_indexes("ingredients")
    }
    if "ix_ingredients_external_id" not in ingredient_indexes:
        op.create_index(
            "ix_ingredients_external_id",
            "ingredients",
            ["external_id"],
            unique=True,
        )
    if "ix_ingredients_normalized_name" not in ingredient_indexes:
        op.create_index(
            "ix_ingredients_normalized_name",
            "ingredients",
            ["normalized_name"],
        )

    inventory_indexes = {
        index["name"] for index in inspector.get_indexes("inventory_items")
    }
    if "ix_inventory_items_ingredient_id" not in inventory_indexes:
        op.create_index(
            "ix_inventory_items_ingredient_id",
            "inventory_items",
            ["ingredient_id"],
            unique=True,
        )


def downgrade():
    bind = op.get_bind()
    inspector = inspect(bind)
    tables = set(inspector.get_table_names())
    if "ingredient_lineage" in tables:
        op.drop_table("ingredient_lineage")
    if "ingredient_catalog_imports" in tables:
        op.drop_table("ingredient_catalog_imports")
