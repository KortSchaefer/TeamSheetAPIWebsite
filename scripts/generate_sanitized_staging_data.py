from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from scripts.export_sqlite_to_d1 import quote_identifier, sql_literal  # noqa: E402


SCHEMA_MANIFEST = ROOT / "d1" / "schema-manifest.json"
SYNTHETIC_PASSWORD_HASH = (
    "$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$"
    "kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc"
)
FIXED_TIME = "2026-01-15 12:00:00.000000"


def schema_tables() -> dict[str, list[str]]:
    manifest = json.loads(SCHEMA_MANIFEST.read_text(encoding="utf-8"))
    return {
        table["name"]: [column["name"] for column in table["columns"]]
        for table in manifest["tables"]
    }


def require_columns(tables: dict[str, list[str]], table: str, columns: list[str]) -> None:
    missing = set(columns) - set(tables.get(table, []))
    if table not in tables or missing:
        raise ValueError(f"Current D1 schema is missing {table}: {sorted(missing)}")


def insert_statement(table: str, columns: list[str], rows: list[tuple[Any, ...]]) -> str:
    rendered_rows = [
        "(" + ", ".join(sql_literal(value) for value in row) + ")"
        for row in rows
    ]
    return (
        f"INSERT INTO {quote_identifier(table)} "
        f"({', '.join(quote_identifier(column) for column in columns)}) VALUES\n  "
        + ",\n  ".join(rendered_rows)
        + ";"
    )


def dataset() -> dict[str, tuple[list[str], list[tuple[Any, ...]]]]:
    employee_columns = [
        "id", "first_name", "last_name", "nickname", "role",
        "employment_start_date", "active", "upsell_score", "employment_days",
        "max_section_load", "notes", "created_at", "updated_at", "pitty_score",
    ]
    user_columns = [
        "id", "email", "password_hash", "full_name", "role",
        "created_at", "updated_at", "employee_id",
    ]
    location_columns = ["id", "name", "description", "active", "created_at", "updated_at"]
    item_columns = [
        "id", "name", "category", "sku", "base_unit", "purchase_unit",
        "purchase_to_base", "default_location_id", "cost_cents",
        "shelf_life_days", "active", "created_at", "updated_at", "ingredient_id",
    ]
    balance_columns = [
        "id", "inventory_item_id", "location_id", "quantity_on_hand",
        "minimum_quantity", "par_quantity", "maximum_quantity", "created_at",
        "updated_at", "planning_active", "lower_tolerance_percent",
        "upper_tolerance_percent",
    ]

    locations = [
        (920001, "Staging Bar Storage", "Synthetic staging location", 1, FIXED_TIME, FIXED_TIME),
        (920002, "Staging Walk-In", "Synthetic staging location", 1, FIXED_TIME, FIXED_TIME),
    ]
    item_specs = [
        ("Staging Item 01", "Beverage", "bottle", 920001),
        ("Staging Item 02", "Beverage", "bottle", 920001),
        ("Staging Item 03", "Produce", "each", 920002),
        ("Staging Item 04", "Dairy", "gallon", 920002),
        ("Staging Item 05", "Protein", "pound", 920002),
        ("Staging Item 06", "Dry Goods", "case", 920002),
        ("Staging Item 07", "Sauce", "bottle", 920002),
        ("Staging Item 08", "Supply", "case", 920001),
    ]
    items: list[tuple[Any, ...]] = []
    balances: list[tuple[Any, ...]] = []
    for offset, (name, category, unit, location_id) in enumerate(item_specs, start=1):
        item_id = 930000 + offset
        items.append(
            (
                item_id, name, category, f"STG-{offset:04d}", unit, unit, 1,
                location_id, 100 + offset * 25, 30, 1, FIXED_TIME, FIXED_TIME, None,
            )
        )
        balances.append(
            (
                940000 + offset, item_id, location_id, 8 + offset, 5, 12, 18,
                FIXED_TIME, FIXED_TIME, 1, 15, 20,
            )
        )

    return {
        "employees": (
            employee_columns,
            [
                (910001, "SyntheticGiven910001", "SyntheticFamily910001", "StageManager910001", "BARTENDER", "2025-01-01", 1, 110, 365, 4, None, FIXED_TIME, FIXED_TIME, 0),
                (910002, "SyntheticGiven910002", "SyntheticFamily910002", "StageServer910002", "SERVER", "2025-06-01", 1, 104, 180, 3, None, FIXED_TIME, FIXED_TIME, 0),
            ],
        ),
        "users": (
            user_columns,
            [
                (910001, "manager.staging@example.invalid", SYNTHETIC_PASSWORD_HASH, "Synthetic User 910001", "MANAGER", FIXED_TIME, FIXED_TIME, 910001),
                (910002, "server.staging@example.invalid", SYNTHETIC_PASSWORD_HASH, "Synthetic User 910002", "SERVER", FIXED_TIME, FIXED_TIME, 910002),
            ],
        ),
        "inventory_locations": (location_columns, locations),
        "inventory_items": (item_columns, items),
        "inventory_balances": (balance_columns, balances),
    }


def generate(output: Path, manifest_path: Path, reconciliation_path: Path) -> dict[str, Any]:
    tables = schema_tables()
    staged = dataset()
    for table, (columns, _) in staged.items():
        require_columns(tables, table, columns)

    statements = [
        "-- Fully synthetic TeamSheet Studio staging data; contains no production rows.",
        "PRAGMA defer_foreign_keys = ON;",
        *[
            insert_statement(table, columns, rows)
            for table, (columns, rows) in staged.items()
        ],
        "PRAGMA defer_foreign_keys = OFF;",
    ]
    sql = "\n\n".join(statements) + "\n"

    expected_counts = {table: 0 for table in tables}
    expected_counts["menu_categories"] = 11
    for table, (_, rows) in staged.items():
        expected_counts[table] = len(rows)
    count_expressions = [
        f"(SELECT COUNT(*) FROM {quote_identifier(table)}) AS {quote_identifier(table)}"
        for table in sorted(tables)
    ]
    count_query = "SELECT\n  " + ",\n  ".join(count_expressions) + ";\nPRAGMA foreign_key_check;\n"

    manifest = {
        "format_version": 1,
        "classification": "fully_synthetic_staging_only",
        "schema_table_count": len(tables),
        "data_sha256": hashlib.sha256(sql.encode("utf-8")).hexdigest(),
        "expected_row_counts": expected_counts,
        "synthetic_login_emails": [
            "manager.staging@example.invalid",
            "server.staging@example.invalid",
        ],
        "sanitization": {
            "names_and_employee_numbers": "Replaced with fixed synthetic identities and IDs.",
            "authentication": "All source users and POS credentials omitted; two synthetic test hashes generated.",
            "voice": "All voice sessions, utterances, transcripts, object keys, and count data omitted.",
            "operations": "Orders, payments, counts, purchasing, receiving, schedules, payouts, assignments, and audit rows omitted.",
            "inventory": "Eight synthetic items, balances, quantities, costs, and two synthetic locations generated.",
        },
    }
    for path in (output, manifest_path, reconciliation_path):
        path.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(sql, encoding="utf-8", newline="\n")
    manifest_path.write_text(json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8", newline="\n")
    reconciliation_path.write_text(count_query, encoding="utf-8", newline="\n")
    return manifest


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Generate a fully synthetic staging dataset for the current D1 schema.")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--reconciliation", type=Path, required=True)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    manifest = generate(args.output, args.manifest, args.reconciliation)
    total = sum(manifest["expected_row_counts"].values())
    print(f"Generated {total} fully synthetic staging rows across the current {manifest['schema_table_count']}-table schema.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
