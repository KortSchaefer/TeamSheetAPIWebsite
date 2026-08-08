from __future__ import annotations

import argparse
import hashlib
import json
import math
import sqlite3
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any, Iterable, Sequence


DEFAULT_EXCLUDED_TABLES = frozenset({"alembic_version"})


def quote_identifier(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def read_only_connection(path: Path) -> sqlite3.Connection:
    resolved = path.resolve()
    if not resolved.is_file():
        raise FileNotFoundError(resolved)
    connection = sqlite3.connect(
        f"file:{resolved.as_posix()}?mode=ro",
        uri=True,
    )
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA query_only = ON")
    return connection


def resolve_local_d1_database(path: Path) -> Path:
    if path.is_file():
        return path
    candidates = sorted(
        candidate
        for candidate in path.glob("v3/d1/miniflare-D1DatabaseObject/*.sqlite")
        if candidate.name != "metadata.sqlite"
    )
    if len(candidates) != 1:
        raise ValueError(
            f"Expected exactly one local D1 database beneath {path}, found {len(candidates)}"
        )
    return candidates[0]


def user_tables(connection: sqlite3.Connection) -> list[str]:
    return [
        row["name"]
        for row in connection.execute(
            "SELECT name FROM sqlite_schema "
            "WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
            "ORDER BY name"
        )
    ]


def table_columns(connection: sqlite3.Connection, table: str) -> list[sqlite3.Row]:
    return list(connection.execute(f"PRAGMA table_info({quote_identifier(table)})"))


def foreign_key_parents(connection: sqlite3.Connection, table: str) -> set[str]:
    return {
        row["table"]
        for row in connection.execute(f"PRAGMA foreign_key_list({quote_identifier(table)})")
        if row["table"] != table
    }


def foreign_key_order(connection: sqlite3.Connection, tables: Sequence[str]) -> tuple[list[str], list[list[str]]]:
    selected = set(tables)
    parents = {
        table: foreign_key_parents(connection, table) & selected
        for table in tables
    }
    children: dict[str, set[str]] = defaultdict(set)
    in_degree = {table: len(dependencies) for table, dependencies in parents.items()}
    for child, dependencies in parents.items():
        for parent in dependencies:
            children[parent].add(child)

    ready = sorted(table for table, degree in in_degree.items() if degree == 0)
    ordered: list[str] = []
    while ready:
        table = ready.pop(0)
        ordered.append(table)
        for child in sorted(children[table]):
            in_degree[child] -= 1
            if in_degree[child] == 0:
                ready.append(child)
                ready.sort()

    remaining = sorted(selected - set(ordered))
    cycles: list[list[str]] = []
    if remaining:
        # D1 imports run with FK enforcement disabled and are checked afterward,
        # so deterministic ordering is sufficient for cyclic dependency groups.
        cycles.append(remaining)
        ordered.extend(remaining)
    return ordered, cycles


def sql_literal(value: Any, declared_type: str = "") -> str:
    if value is None:
        return "NULL"
    if isinstance(value, bool):
        return "1" if value else "0"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ValueError("D1 export does not support NaN or infinite REAL values")
        return repr(value)
    if isinstance(value, (bytes, bytearray, memoryview)):
        return "X'" + bytes(value).hex().upper() + "'"
    if not isinstance(value, str):
        raise TypeError(f"Unsupported SQLite value type: {type(value).__name__}")

    normalized_type = declared_type.upper()
    if "JSON" in normalized_type:
        try:
            json.loads(value)
        except json.JSONDecodeError as error:
            raise ValueError(f"Invalid JSON value: {error.msg}") from error
    if "BOOL" in normalized_type and value not in {"0", "1"}:
        raise ValueError(f"Invalid Boolean value {value!r}")
    if "\x00" in value:
        return "CAST(X'" + value.encode("utf-8").hex().upper() + "' AS TEXT)"
    return "'" + value.replace("'", "''") + "'"


def batched(values: Sequence[str], size: int) -> Iterable[Sequence[str]]:
    for start in range(0, len(values), size):
        yield values[start : start + size]


@dataclass(frozen=True)
class ExportTable:
    name: str
    row_count: int
    columns: list[str]
    parent_tables: list[str]


def render_table_data(
    connection: sqlite3.Connection,
    table: str,
    *,
    rows_per_insert: int,
) -> tuple[str, ExportTable]:
    column_rows = table_columns(connection, table)
    if not column_rows:
        raise ValueError(f"Table {table!r} has no columns")
    columns = [row["name"] for row in column_rows]
    types = [row["type"] or "" for row in column_rows]
    select_columns = ", ".join(quote_identifier(column) for column in columns)
    primary_key = [
        row["name"]
        for row in sorted(column_rows, key=lambda item: item["pk"] or sys.maxsize)
        if row["pk"]
    ]
    order_expression = (
        ", ".join(quote_identifier(column) for column in primary_key)
        if primary_key
        else "rowid"
    )
    rows = list(
        connection.execute(
            f"SELECT {select_columns} FROM {quote_identifier(table)} ORDER BY {order_expression}"
        )
    )
    rendered_rows = [
        "(" + ", ".join(sql_literal(value, declared_type) for value, declared_type in zip(row, types, strict=True)) + ")"
        for row in rows
    ]
    statements: list[str] = []
    if rendered_rows:
        prefix = (
            f"INSERT INTO {quote_identifier(table)} "
            f"({', '.join(quote_identifier(column) for column in columns)}) VALUES\n  "
        )
        for batch in batched(rendered_rows, rows_per_insert):
            statements.append(prefix + ",\n  ".join(batch) + ";")
    parents = sorted(foreign_key_parents(connection, table))
    return "\n\n".join(statements), ExportTable(table, len(rows), columns, parents)


def export_database(
    source: Path,
    output: Path,
    manifest_path: Path,
    *,
    rows_per_insert: int = 100,
    excluded_tables: frozenset[str] = DEFAULT_EXCLUDED_TABLES,
) -> dict[str, Any]:
    if rows_per_insert < 1:
        raise ValueError("rows_per_insert must be positive")
    resolved_source = source.resolve()
    resolved_output = output.resolve()
    resolved_manifest = manifest_path.resolve()
    if resolved_source in {resolved_output, resolved_manifest}:
        raise ValueError("Export output and manifest must not overwrite the source database")
    if resolved_output == resolved_manifest:
        raise ValueError("Export output and manifest must be different files")
    before = source.stat()
    with read_only_connection(source) as connection:
        available = user_tables(connection)
        tables = [table for table in available if table not in excluded_tables]
        order, cycles = foreign_key_order(connection, tables)
        sections: list[str] = []
        exported: list[ExportTable] = []
        for table in order:
            sql, metadata = render_table_data(
                connection, table, rows_per_insert=rows_per_insert
            )
            exported.append(metadata)
            if sql:
                sections.append(f"-- {table}: {metadata.row_count} rows\n{sql}")
        source_violations = [dict(row) for row in connection.execute("PRAGMA foreign_key_check")]
    after = source.stat()
    if (before.st_size, before.st_mtime_ns) != (after.st_size, after.st_mtime_ns):
        raise RuntimeError("Source database changed during export; discard the output and retry")

    header = [
        "-- TeamSheet Studio schema-independent SQLite-to-D1 data export.",
        "-- Source is opened read-only; schema and SQLite/Alembic metadata are excluded.",
        "-- Apply to an empty database that already has the matching D1 schema.",
        "PRAGMA defer_foreign_keys = ON;",
    ]
    footer = [
        "PRAGMA defer_foreign_keys = OFF;",
        "-- Run PRAGMA foreign_key_check after import; the validator does this automatically.",
    ]
    content = "\n".join(header) + "\n\n" + "\n\n".join(sections) + "\n\n" + "\n".join(footer) + "\n"
    digest = hashlib.sha256(content.encode("utf-8")).hexdigest()
    manifest = {
        "format_version": 1,
        "source": str(source.resolve()),
        "source_size": before.st_size,
        "source_mtime_ns": before.st_mtime_ns,
        "output_sha256": digest,
        "excluded_table_patterns": ["sqlite_%"],
        "excluded_tables": sorted(set(available) - set(tables)),
        "foreign_key_order": order,
        "foreign_key_cycles": cycles,
        "source_foreign_key_violations": source_violations,
        "tables": [asdict(table) for table in exported],
        "total_rows": sum(table.row_count for table in exported),
    }
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(content, encoding="utf-8", newline="\n")
    manifest_path.write_text(
        json.dumps(manifest, indent=2, sort_keys=True, ensure_ascii=False) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return manifest


def row_counts(connection: sqlite3.Connection, tables: Sequence[str]) -> dict[str, int]:
    return {
        table: connection.execute(
            f"SELECT COUNT(*) FROM {quote_identifier(table)}"
        ).fetchone()[0]
        for table in tables
    }


def validate_databases(source: Path, destination: Path, tables: Sequence[str]) -> dict[str, Any]:
    resolved_destination = resolve_local_d1_database(destination)
    if source.resolve() == resolved_destination.resolve():
        raise ValueError("Source and destination databases must be different files")
    with read_only_connection(source) as source_connection, read_only_connection(resolved_destination) as destination_connection:
        source_available = set(user_tables(source_connection))
        destination_available = set(user_tables(destination_connection))
        missing_source = sorted(set(tables) - source_available)
        missing_destination = sorted(set(tables) - destination_available)
        comparable = [
            table
            for table in tables
            if table in source_available and table in destination_available
        ]
        source_counts = row_counts(source_connection, comparable)
        destination_counts = row_counts(destination_connection, comparable)
        mismatches = {
            table: {"source": source_counts[table], "destination": destination_counts[table]}
            for table in comparable
            if source_counts[table] != destination_counts[table]
        }
        source_foreign_keys = [dict(row) for row in source_connection.execute("PRAGMA foreign_key_check")]
        destination_foreign_keys = [dict(row) for row in destination_connection.execute("PRAGMA foreign_key_check")]
    return {
        "ok": not missing_source
        and not missing_destination
        and not mismatches
        and not source_foreign_keys
        and not destination_foreign_keys,
        "tables_checked": len(comparable),
        "missing_source_tables": missing_source,
        "missing_destination_tables": missing_destination,
        "row_count_mismatches": mismatches,
        "source_foreign_key_violations": source_foreign_keys,
        "destination_foreign_key_violations": destination_foreign_keys,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export SQLite application rows as D1-compatible SQL and validate a local D1 import."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    export_parser = subparsers.add_parser("export", help="Create data SQL and a reconciliation manifest.")
    export_parser.add_argument("source", type=Path)
    export_parser.add_argument("--output", type=Path, required=True)
    export_parser.add_argument("--manifest", type=Path, required=True)
    export_parser.add_argument("--rows-per-insert", type=int, default=100)

    validate_parser = subparsers.add_parser("validate", help="Compare a source SQLite database with a stopped local D1 SQLite file.")
    validate_parser.add_argument("source", type=Path)
    validate_parser.add_argument(
        "destination",
        type=Path,
        help="A stopped local D1 SQLite file or its Wrangler --persist-to directory.",
    )
    validate_parser.add_argument("--manifest", type=Path, required=True)
    validate_parser.add_argument("--report", type=Path)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    if args.command == "export":
        manifest = export_database(
            args.source,
            args.output,
            args.manifest,
            rows_per_insert=args.rows_per_insert,
        )
        print(
            f"Exported {manifest['total_rows']} rows from {len(manifest['tables'])} tables; "
            f"source FK violations: {len(manifest['source_foreign_key_violations'])}."
        )
        return 0

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    tables = [table["name"] for table in manifest["tables"]]
    report = validate_databases(args.source, args.destination, tables)
    source_stat = args.source.stat()
    report["source_matches_manifest"] = (
        source_stat.st_size == manifest.get("source_size")
        and source_stat.st_mtime_ns == manifest.get("source_mtime_ns")
    )
    report["ok"] = report["ok"] and report["source_matches_manifest"]
    rendered = json.dumps(report, indent=2, sort_keys=True, ensure_ascii=False) + "\n"
    if args.report:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(rendered, encoding="utf-8", newline="\n")
    print(rendered, end="")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
