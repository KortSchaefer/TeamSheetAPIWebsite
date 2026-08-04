from sqlalchemy import create_engine, inspect, text
from sqlalchemy.pool import StaticPool

from app.database import ensure_sqlite_pos_columns


def test_sqlite_pos_schema_repair_is_idempotent():
    repair_engine = create_engine(
        "sqlite+pysqlite:///:memory:",
        future=True,
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with repair_engine.begin() as connection:
        connection.execute(
            text(
                """
                CREATE TABLE pos_tables (
                    id INTEGER PRIMARY KEY,
                    table_number INTEGER NOT NULL,
                    active_number_key VARCHAR(20),
                    owner_employee_id INTEGER NOT NULL,
                    status VARCHAR(6) NOT NULL,
                    progress VARCHAR(14) NOT NULL,
                    revision INTEGER NOT NULL,
                    opened_at DATETIME NOT NULL,
                    closed_at DATETIME,
                    created_at DATETIME NOT NULL,
                    updated_at DATETIME NOT NULL
                )
                """
            )
        )

    ensure_sqlite_pos_columns(repair_engine)
    ensure_sqlite_pos_columns(repair_engine)

    repaired = inspect(repair_engine)
    columns = {
        column["name"] for column in repaired.get_columns("pos_tables")
    }
    indexes = {
        index["name"]: index for index in repaired.get_indexes("pos_tables")
    }
    assert "client_request_id" in columns
    assert indexes["ix_pos_tables_client_request_id"]["unique"] == 1
