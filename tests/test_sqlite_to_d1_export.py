from __future__ import annotations

import json
import sqlite3
from pathlib import Path

import pytest

from scripts.export_sqlite_to_d1 import (
    export_database,
    read_only_connection,
    resolve_local_d1_database,
    validate_databases,
)


SCHEMA = """
PRAGMA foreign_keys = ON;
CREATE TABLE parents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  active BOOLEAN NOT NULL,
  created_at DATETIME,
  payload JSON,
  note TEXT,
  bytes BLOB
);
CREATE TABLE children (
  id INTEGER PRIMARY KEY,
  parent_id INTEGER NOT NULL REFERENCES parents(id),
  label TEXT
);
"""


def fixture_database(path: Path) -> None:
    connection = sqlite3.connect(path)
    connection.executescript(SCHEMA)
    connection.execute(
        "INSERT INTO parents (id, name, active, created_at, payload, note, bytes) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (
            1,
            "Manager's café",
            True,
            "2026-08-04 17:30:00.123456",
            json.dumps({"quoted": "O'Reilly", "enabled": True}),
            "contains\x00nul",
            b"\x00\xff",
        ),
    )
    connection.execute(
        "INSERT INTO children (id, parent_id, label) VALUES (?, ?, ?)",
        (10, 1, None),
    )
    connection.execute("CREATE TABLE alembic_version (version_num TEXT PRIMARY KEY)")
    connection.execute("INSERT INTO alembic_version VALUES ('fixture')")
    connection.commit()
    connection.close()


def test_export_round_trip_handles_types_ordering_and_internal_tables(tmp_path: Path):
    source = tmp_path / "source.db"
    destination = tmp_path / "destination.sqlite"
    output = tmp_path / "data.sql"
    manifest_path = tmp_path / "manifest.json"
    fixture_database(source)

    before = source.read_bytes()
    manifest = export_database(source, output, manifest_path, rows_per_insert=1)
    assert source.read_bytes() == before
    assert manifest["foreign_key_order"].index("parents") < manifest["foreign_key_order"].index("children")
    assert manifest["excluded_table_patterns"] == ["sqlite_%"]
    assert manifest["excluded_tables"] == ["alembic_version"]
    assert manifest["source_foreign_key_violations"] == []

    sql = output.read_text(encoding="utf-8")
    assert "PRAGMA defer_foreign_keys = ON;" in sql
    assert "PRAGMA foreign_keys = OFF;" not in sql
    assert "Manager''s café" in sql
    assert "CAST(X'636F6E7461696E73006E756C' AS TEXT)" in sql
    assert "X'00FF'" in sql
    assert 'INSERT INTO "alembic_version"' not in sql
    assert 'INSERT INTO "sqlite_sequence"' not in sql

    destination_connection = sqlite3.connect(destination)
    destination_connection.executescript(SCHEMA)
    destination_connection.executescript(sql)
    destination_connection.close()

    report = validate_databases(
        source,
        destination,
        [table["name"] for table in manifest["tables"]],
    )
    assert report == {
        "ok": True,
        "tables_checked": 2,
        "missing_source_tables": [],
        "missing_destination_tables": [],
        "row_count_mismatches": {},
        "source_foreign_key_violations": [],
        "destination_foreign_key_violations": [],
    }


def test_read_only_connection_rejects_mutation(tmp_path: Path):
    source = tmp_path / "source.db"
    fixture_database(source)
    with read_only_connection(source) as connection:
        with pytest.raises(sqlite3.OperationalError, match="readonly"):
            connection.execute("DELETE FROM parents")


def test_export_refuses_to_overwrite_source(tmp_path: Path):
    source = tmp_path / "source.db"
    fixture_database(source)
    with pytest.raises(ValueError, match="must not overwrite"):
        export_database(source, source, tmp_path / "manifest.json")


def test_validation_reports_counts_and_foreign_key_violations(tmp_path: Path):
    source = tmp_path / "source.db"
    destination = tmp_path / "destination.sqlite"
    fixture_database(source)
    destination_connection = sqlite3.connect(destination)
    destination_connection.executescript(SCHEMA)
    destination_connection.execute("PRAGMA foreign_keys = OFF")
    destination_connection.execute(
        "INSERT INTO children (id, parent_id, label) VALUES (10, 999, 'orphan')"
    )
    destination_connection.commit()
    destination_connection.close()

    report = validate_databases(source, destination, ["parents", "children"])
    assert report["ok"] is False
    assert report["row_count_mismatches"] == {
        "parents": {"source": 1, "destination": 0}
    }
    assert report["source_foreign_key_violations"] == []
    assert report["destination_foreign_key_violations"] == [
        {"table": "children", "rowid": 10, "parent": "parents", "fkid": 0}
    ]


def test_local_d1_directory_resolution_rejects_ambiguous_state(tmp_path: Path):
    database_dir = tmp_path / "v3" / "d1" / "miniflare-D1DatabaseObject"
    database_dir.mkdir(parents=True)
    expected = database_dir / "fixture.sqlite"
    expected.touch()
    (database_dir / "metadata.sqlite").touch()
    assert resolve_local_d1_database(tmp_path) == expected
    (database_dir / "second.sqlite").touch()
    with pytest.raises(ValueError, match="exactly one"):
        resolve_local_d1_database(tmp_path)
