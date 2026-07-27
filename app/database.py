from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, DeclarativeBase

from app.config import settings


connect_args = {}
if settings.database_url.startswith("sqlite"):
    connect_args["check_same_thread"] = False

engine = create_engine(settings.database_url, future=True, connect_args=connect_args)
SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


class Base(DeclarativeBase):
    pass


def ensure_sqlite_sections_columns():
    if not settings.database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    with engine.connect() as conn:
        columns = [row[1] for row in conn.execute(text("PRAGMA table_info(sections)"))]
        if "tables" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN tables TEXT"))
        if "tags" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN tags TEXT"))
        if "cut_order" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN cut_order INTEGER"))
        if "sidework" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN sidework TEXT"))
        if "outwork" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN outwork TEXT"))
        if "max_capacity" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN max_capacity INTEGER"))
        if "expected_out_time" not in columns:
            conn.execute(text("ALTER TABLE sections ADD COLUMN expected_out_time VARCHAR(50)"))
        conn.commit()


def ensure_sqlite_user_columns():
    if not settings.database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    with engine.connect() as conn:
        columns = [row[1] for row in conn.execute(text("PRAGMA table_info(users)"))]
        if "employee_id" not in columns:
            conn.execute(text("ALTER TABLE users ADD COLUMN employee_id INTEGER"))
        conn.commit()


def ensure_sqlite_inventory_columns():
    if not settings.database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    with engine.connect() as conn:
        columns = [row[1] for row in conn.execute(text("PRAGMA table_info(stock_movements)"))]
        additions = {
            "inventory_item_id": "INTEGER",
            "location_id": "INTEGER",
            "source_event_key": "VARCHAR(255)",
            "lot_number": "VARCHAR(100)",
            "expiration_date": "DATE",
            "created_by_user_id": "INTEGER",
        }
        for name, sql_type in additions.items():
            if name not in columns:
                conn.execute(text(f"ALTER TABLE stock_movements ADD COLUMN {name} {sql_type}"))
        conn.commit()


def ensure_sqlite_catalog_columns():
    if not settings.database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    with engine.connect() as conn:
        ingredient_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(ingredients)"))
        ]
        ingredient_additions = {
            "external_id": "VARCHAR(150)",
            "normalized_name": "VARCHAR(150)",
            "category": "VARCHAR(100)",
            "stage": "VARCHAR(50)",
            "process": "TEXT",
            "added_to_complete_lineage": "BOOLEAN DEFAULT 0",
            "source_correction": "TEXT",
            "resolution_needed": "TEXT",
            "catalog_schema_version": "VARCHAR(30)",
            "catalog_metadata": "JSON",
        }
        for name, sql_type in ingredient_additions.items():
            if name not in ingredient_columns:
                conn.execute(text(f"ALTER TABLE ingredients ADD COLUMN {name} {sql_type}"))

        inventory_item_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(inventory_items)"))
        ]
        if "ingredient_id" not in inventory_item_columns:
            conn.execute(text("ALTER TABLE inventory_items ADD COLUMN ingredient_id INTEGER"))

        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_ingredients_external_id "
                "ON ingredients (external_id)"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_ingredients_normalized_name "
                "ON ingredients (normalized_name)"
            )
        )
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_inventory_items_ingredient_id "
                "ON inventory_items (ingredient_id)"
            )
        )
        conn.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
