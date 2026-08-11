from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from scripts.generate_sanitized_staging_data import generate


ROOT = Path(__file__).resolve().parents[1]


def test_sanitized_staging_dataset_matches_schema_and_contains_no_operational_rows(tmp_path: Path):
    output = tmp_path / "staging.sql"
    manifest_path = tmp_path / "manifest.json"
    reconciliation = tmp_path / "reconcile.sql"
    manifest = generate(output, manifest_path, reconciliation)

    connection = sqlite3.connect(":memory:")
    connection.row_factory = sqlite3.Row
    for migration in sorted((ROOT / "d1/migrations").glob("*.sql")):
        connection.executescript(migration.read_text(encoding="utf-8"))
    connection.executescript(output.read_text(encoding="utf-8"))

    actual_counts = {
        table: connection.execute(f'SELECT COUNT(*) FROM "{table}"').fetchone()[0]
        for table in manifest["expected_row_counts"]
    }
    assert actual_counts == manifest["expected_row_counts"]
    assert list(connection.execute("PRAGMA foreign_key_check")) == []
    assert connection.execute("SELECT COUNT(*) FROM inventory_voice_sessions").fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM pos_credentials").fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM pos_orders").fetchone()[0] == 0
    assert connection.execute("SELECT COUNT(*) FROM inventory_purchase_orders").fetchone()[0] == 0
    users = [dict(row) for row in connection.execute("SELECT email, full_name, role FROM users ORDER BY id")]
    assert users == [
        {"email": "manager.staging@example.invalid", "full_name": "Synthetic User 910001", "role": "MANAGER"},
        {"email": "server.staging@example.invalid", "full_name": "Synthetic User 910002", "role": "SERVER"},
    ]

    rendered = output.read_text(encoding="utf-8")
    assert "audio_object_key" not in rendered
    assert "transcript" not in rendered
    assert "pin_hash" not in rendered
    assert json.loads(manifest_path.read_text(encoding="utf-8"))["classification"] == "fully_synthetic_staging_only"
    reconciliation_sql = reconciliation.read_text(encoding="utf-8")
    assert "UNION ALL" not in reconciliation_sql
    assert reconciliation_sql.count(";\n") == 2
