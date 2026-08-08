from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any

# Importing app.database normally opens the configured FastAPI database and runs
# startup compatibility code through app.main. Schema generation must never touch
# team_sheet.db, so force the SQLAlchemy metadata onto an in-memory database first.
os.environ["DATABASE_URL"] = "sqlite+pysqlite:///:memory:"

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from sqlalchemy import DefaultClause, UniqueConstraint, text  # noqa: E402
from sqlalchemy.dialects.sqlite import dialect as sqlite_dialect  # noqa: E402
from sqlalchemy.schema import CreateIndex, CreateTable  # noqa: E402

from app import models  # noqa: E402,F401
from app.database import Base  # noqa: E402


D1_ROOT = REPOSITORY_ROOT / "d1"
MIGRATIONS_DIR = D1_ROOT / "migrations"
INITIAL_SCHEMA_PATH = MIGRATIONS_DIR / "0001_initial_schema.sql"
POS_SEED_PATH = MIGRATIONS_DIR / "0002_seed_pos_categories.sql"
MANIFEST_PATH = D1_ROOT / "schema-manifest.json"

# These defaults were introduced by Alembic or the legacy SQLite startup repair
# hooks. They must be part of the clean D1 schema rather than runtime ALTER TABLEs.
REPAIR_SERVER_DEFAULTS: dict[tuple[str, str], str] = {
    ("ingredients", "added_to_complete_lineage"): "0",
    ("inventory_balances", "planning_active"): "1",
    ("inventory_count_lines", "display_order"): "0",
    ("inventory_count_lines", "is_counted"): "1",
    ("inventory_count_lines", "review_status"): "'READY'",
    ("inventory_count_lines", "revision"): "1",
    ("inventory_counts", "revision"): "1",
    ("inventory_purchase_order_lines", "quantity_per_purchase_unit"): "1",
    ("menu_categories", "display_order"): "0",
    ("pos_orders", "check_number"): "1",
    ("pos_orders", "progress"): "'FOOD_UNORDERED'",
    ("pos_orders", "subtotal_cents"): "0",
    ("pos_orders", "tax_cents"): "0",
    ("pos_orders", "tip_cents"): "0",
    ("pos_orders", "total_cents"): "0",
    ("pos_orders", "print_count"): "0",
    ("store_preferences", "blast_minimum_percent"): "98",
}

POS_CATEGORIES = [
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


def canonical_json(value: Any) -> str:
    return json.dumps(value, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def _compile_tables() -> list[str]:
    dialect = sqlite_dialect()
    statements: list[str] = []
    for table in Base.metadata.sorted_tables:
        restored_defaults = []
        for column in table.columns:
            default = REPAIR_SERVER_DEFAULTS.get((table.name, column.name))
            if default is None:
                continue
            restored_defaults.append((column, column.server_default))
            column.server_default = DefaultClause(text(default))
        try:
            statements.append(str(CreateTable(table).compile(dialect=dialect)).strip())
        finally:
            for column, original in restored_defaults:
                column.server_default = original
    return statements


def _compile_indexes() -> list[str]:
    dialect = sqlite_dialect()
    indexes = sorted(
        (index for table in Base.metadata.tables.values() for index in table.indexes),
        key=lambda index: index.name or "",
    )
    return [str(CreateIndex(index).compile(dialect=dialect)).strip() for index in indexes]


def render_initial_schema() -> str:
    statements = [
        "-- TeamSheet Studio D1 schema generated from SQLAlchemy metadata.",
        "-- Alembic revisions 0001-0009 and SQLite startup repairs are folded into",
        "-- this clean baseline. Do not edit after it has been applied remotely.",
        "PRAGMA defer_foreign_keys = ON;",
        *_compile_tables(),
        *_compile_indexes(),
        "PRAGMA defer_foreign_keys = OFF;",
    ]
    return "\n\n".join(f"{statement};" if not statement.endswith(";") else statement for statement in statements) + "\n"


def render_pos_seed() -> str:
    values = []
    for display_order, name in enumerate(POS_CATEGORIES, start=1):
        escaped = name.replace("'", "''")
        values.append(
            f"('{escaped}', 'POS V1 category', 1, {display_order})"
        )
    return (
        "-- Preserve the menu-category seed introduced by Alembic revision 0005.\n"
        "INSERT INTO menu_categories\n"
        "  (name, description, active, display_order)\n"
        "VALUES\n  "
        + ",\n  ".join(values)
        + "\nON CONFLICT(name) DO UPDATE SET\n"
        "  description = excluded.description,\n"
        "  active = excluded.active,\n"
        "  display_order = excluded.display_order;\n"
    )


def _column_type(column: Any) -> str:
    return str(column.type.compile(dialect=sqlite_dialect())).upper()


def build_manifest() -> dict[str, Any]:
    tables = []
    for table in sorted(Base.metadata.tables.values(), key=lambda item: item.name):
        primary_key = [column.name for column in table.primary_key.columns]
        unique_constraints = sorted(
            [
                [column.name for column in constraint.columns]
                for constraint in table.constraints
                if isinstance(constraint, UniqueConstraint)
            ]
        )
        foreign_keys = []
        for constraint in table.foreign_key_constraints:
            elements = list(constraint.elements)
            foreign_keys.append(
                {
                    "columns": [element.parent.name for element in elements],
                    "referenced_table": elements[0].column.table.name,
                    "referenced_columns": [element.column.name for element in elements],
                    "on_delete": constraint.ondelete or "NO ACTION",
                    "on_update": constraint.onupdate or "NO ACTION",
                }
            )
        foreign_keys.sort(
            key=lambda item: (item["columns"], item["referenced_table"])
        )
        indexes = []
        for index in sorted(table.indexes, key=lambda item: item.name or ""):
            columns = [getattr(expression, "name", None) for expression in index.expressions]
            if any(column is None for column in columns):
                raise ValueError(f"Expression index {index.name} needs explicit manifest support")
            indexes.append(
                {"name": index.name, "columns": columns, "unique": bool(index.unique)}
            )
        columns = []
        for column in table.columns:
            columns.append(
                {
                    "name": column.name,
                    "type": _column_type(column),
                    "nullable": bool(column.nullable),
                    "primary_key_position": (
                        primary_key.index(column.name) + 1 if column.name in primary_key else 0
                    ),
                    "default": REPAIR_SERVER_DEFAULTS.get((table.name, column.name)),
                }
            )
        tables.append(
            {
                "name": table.name,
                "columns": columns,
                "foreign_keys": foreign_keys,
                "unique_constraints": unique_constraints,
                "indexes": indexes,
            }
        )
    return {
        "format_version": 1,
        "source": {
            "sqlalchemy_models": "app/models/models.py",
            "alembic_revisions": [
                "0001_inventory_workspace",
                "0002_ingredient_catalog",
                "0003_voice_inventory",
                "0004_spreadsheet_count_sheets",
                "0005_pos_terminal_v1",
                "0006_repair_pos_table_request_id",
                "0007_purchase_order_csv_import",
                "0008_inventory_planning",
                "0009_store_blast_threshold",
            ],
            "startup_repairs": "app/database.py",
        },
        "table_count": len(tables),
        "tables": tables,
    }


def expected_files() -> dict[Path, str]:
    return {
        INITIAL_SCHEMA_PATH: render_initial_schema(),
        POS_SEED_PATH: render_pos_seed(),
        MANIFEST_PATH: canonical_json(build_manifest()),
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate or verify the initial D1 schema.")
    parser.add_argument(
        "--check", action="store_true", help="Fail instead of rewriting stale artifacts."
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    files = expected_files()
    if args.check:
        stale = [
            path for path, expected in files.items()
            if not path.exists() or path.read_text(encoding="utf-8") != expected
        ]
        if stale:
            print("D1 schema artifacts are stale:")
            for path in stale:
                print(f"- {path}")
            return 1
        print("D1 schema artifacts match SQLAlchemy and Alembic inputs.")
        return 0

    MIGRATIONS_DIR.mkdir(parents=True, exist_ok=True)
    for path, content in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    print(f"Generated {len(Base.metadata.tables)} D1 tables in {MIGRATIONS_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
