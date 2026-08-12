from __future__ import annotations

import json
import sqlite3
import subprocess
import sys
from collections import Counter
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
D1_ROOT = ROOT / "d1"
MIGRATIONS = sorted((D1_ROOT / "migrations").glob("*.sql"))
MANIFEST = json.loads((D1_ROOT / "schema-manifest.json").read_text(encoding="utf-8"))


def migrated_database(*, through: int | None = None) -> sqlite3.Connection:
    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    selected = MIGRATIONS if through is None else MIGRATIONS[:through]
    for migration in selected:
        connection.executescript(migration.read_text(encoding="utf-8"))
    return connection


def normalized_default(value):
    return None if value is None else str(value)


def test_generated_d1_artifacts_are_current():
    result = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "generate_d1_schema.py"), "--check"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


def test_migrated_schema_matches_all_sqlalchemy_tables_columns_and_relationships():
    connection = migrated_database()
    actual_tables = {
        row["name"]
        for row in connection.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
        )
    }
    expected_tables = {table["name"] for table in MANIFEST["tables"]}
    # Worker-only R2 metadata is intentionally outside the SQLAlchemy model set.
    assert actual_tables - {"inventory_voice_audio_objects"} == expected_tables
    assert len(expected_tables) == MANIFEST["table_count"] == 81

    for table in MANIFEST["tables"]:
        name = table["name"]
        columns = [dict(row) for row in connection.execute(f'PRAGMA table_info("{name}")')]
        assert [column["name"] for column in columns] == [
            column["name"] for column in table["columns"]
        ]
        for actual, expected in zip(columns, table["columns"], strict=True):
            assert actual["type"].upper() == expected["type"]
            assert bool(actual["notnull"]) is (not expected["nullable"])
            assert actual["pk"] == expected["primary_key_position"]
            assert normalized_default(actual["dflt_value"]) == expected["default"]

        actual_foreign_keys = []
        grouped: dict[int, list[sqlite3.Row]] = {}
        for row in connection.execute(f'PRAGMA foreign_key_list("{name}")'):
            grouped.setdefault(row["id"], []).append(row)
        for rows in grouped.values():
            rows.sort(key=lambda row: row["seq"])
            actual_foreign_keys.append(
                {
                    "columns": [row["from"] for row in rows],
                    "referenced_table": rows[0]["table"],
                    "referenced_columns": [row["to"] for row in rows],
                    "on_delete": rows[0]["on_delete"],
                    "on_update": rows[0]["on_update"],
                }
            )
        key = lambda item: (item["columns"], item["referenced_table"])
        assert sorted(actual_foreign_keys, key=key) == sorted(table["foreign_keys"], key=key)

        index_rows = [
            dict(row) for row in connection.execute(f'PRAGMA index_list("{name}")')
        ]
        actual_indexes = {}
        actual_unique_columns = []
        for index in index_rows:
            index_columns = [
                row["name"]
                for row in connection.execute(
                    f'PRAGMA index_info("{index["name"]}")'
                )
            ]
            if index["unique"]:
                actual_unique_columns.append(tuple(index_columns))
            if index["name"] in {item["name"] for item in table["indexes"]}:
                actual_indexes[index["name"]] = {
                    "name": index["name"],
                    "columns": index_columns,
                    "unique": bool(index["unique"]),
                }
        assert sorted(actual_indexes.values(), key=lambda item: item["name"]) == table[
            "indexes"
        ]
        expected_unique_columns = [
            tuple(columns) for columns in table["unique_constraints"]
        ] + [
            tuple(index["columns"])
            for index in table["indexes"]
            if index["unique"]
        ]
        assert Counter(actual_unique_columns) == Counter(expected_unique_columns)

    assert list(connection.execute("PRAGMA foreign_key_check")) == []


def test_pos_seed_is_incremental_and_idempotent():
    connection = migrated_database(through=1)
    connection.execute(
        "INSERT INTO menu_categories (name, description, active, display_order) "
        "VALUES ('Drinks', 'Legacy value', 0, 99)"
    )
    seed_sql = MIGRATIONS[1].read_text(encoding="utf-8")
    connection.executescript(seed_sql)
    connection.executescript(seed_sql)

    rows = list(
        connection.execute(
            "SELECT name, description, active, display_order "
            "FROM menu_categories ORDER BY display_order"
        )
    )
    assert len(rows) == 11
    assert dict(rows[0]) == {
        "name": "Drinks",
        "description": "POS V1 category",
        "active": 1,
        "display_order": 1,
    }
