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


def ensure_sqlite_store_preference_columns():
    if not settings.database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    with engine.connect() as conn:
        columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(store_preferences)"))
        ]
        if columns and "blast_minimum_percent" not in columns:
            conn.execute(
                text(
                    "ALTER TABLE store_preferences "
                    "ADD COLUMN blast_minimum_percent FLOAT NOT NULL DEFAULT 98"
                )
            )
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

        purchase_order_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(inventory_purchase_orders)"))
        ]
        purchase_order_additions = {
            "external_reference": "VARCHAR(100)",
            "import_source_hash": "VARCHAR(64)",
            "imported_filename": "VARCHAR(255)",
        }
        for name, sql_type in purchase_order_additions.items():
            if name not in purchase_order_columns:
                conn.execute(
                    text(f"ALTER TABLE inventory_purchase_orders ADD COLUMN {name} {sql_type}")
                )
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS ix_inventory_purchase_orders_import_source_hash "
                "ON inventory_purchase_orders (import_source_hash)"
            )
        )
        conn.execute(
            text(
                "CREATE UNIQUE INDEX IF NOT EXISTS uq_purchase_order_vendor_reference "
                "ON inventory_purchase_orders (vendor_id, external_reference)"
            )
        )

        balance_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(inventory_balances)"))
        ]
        balance_additions = {
            "planning_active": "BOOLEAN NOT NULL DEFAULT 1",
            "lower_tolerance_percent": "NUMERIC(6, 2)",
            "upper_tolerance_percent": "NUMERIC(6, 2)",
        }
        for name, sql_type in balance_additions.items():
            if name not in balance_columns:
                conn.execute(text(f"ALTER TABLE inventory_balances ADD COLUMN {name} {sql_type}"))

        order_line_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(inventory_purchase_order_lines)"))
        ]
        order_line_additions = {
            "location_id": "INTEGER",
            "purchase_unit": "VARCHAR(30)",
            "quantity_per_purchase_unit": "NUMERIC(12, 4) NOT NULL DEFAULT 1",
        }
        for name, sql_type in order_line_additions.items():
            if name not in order_line_columns:
                conn.execute(
                    text(f"ALTER TABLE inventory_purchase_order_lines ADD COLUMN {name} {sql_type}")
                )

        receiving_line_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(inventory_receiving_lines)"))
        ]
        if "purchase_order_line_id" not in receiving_line_columns:
            conn.execute(
                text(
                    "ALTER TABLE inventory_receiving_lines "
                    "ADD COLUMN purchase_order_line_id INTEGER"
                )
            )

        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_inventory_purchase_order_lines_location_id "
                "ON inventory_purchase_order_lines (location_id)"
            )
        )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_inventory_receiving_lines_purchase_order_line_id "
                "ON inventory_receiving_lines (purchase_order_line_id)"
            )
        )
        for weekday in range(7):
            conn.execute(
                text(
                    "INSERT OR IGNORE INTO inventory_weekday_targets "
                    "(inventory_item_id, location_id, weekday, target_quantity, created_at, updated_at) "
                    "SELECT inventory_item_id, location_id, :weekday, par_quantity, "
                    "CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM inventory_balances "
                    "WHERE par_quantity > 0"
                ),
                {"weekday": weekday},
            )
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


def ensure_sqlite_count_sheet_columns():
    if not settings.database_url.startswith("sqlite"):
        return
    from sqlalchemy import text

    with engine.connect() as conn:
        count_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(inventory_counts)"))
        ]
        count_additions = {
            "template_id": "INTEGER",
            "revision": "INTEGER NOT NULL DEFAULT 1",
            "approved_at": "DATETIME",
        }
        for name, sql_type in count_additions.items():
            if name not in count_columns:
                conn.execute(
                    text(f"ALTER TABLE inventory_counts ADD COLUMN {name} {sql_type}")
                )

        line_columns = [
            row[1]
            for row in conn.execute(text("PRAGMA table_info(inventory_count_lines)"))
        ]
        line_additions = {
            "display_order": "INTEGER NOT NULL DEFAULT 0",
            "is_counted": "BOOLEAN NOT NULL DEFAULT 1",
            "source": "VARCHAR(20)",
            "confidence": "FLOAT",
            "review_status": "VARCHAR(30) NOT NULL DEFAULT 'READY'",
            "evidence": "TEXT",
            "revision": "INTEGER NOT NULL DEFAULT 1",
            "updated_by_user_id": "INTEGER",
        }
        for name, sql_type in line_additions.items():
            if name not in line_columns:
                conn.execute(
                    text(
                        f"ALTER TABLE inventory_count_lines ADD COLUMN {name} {sql_type}"
                    )
                )
        conn.execute(
            text(
                "CREATE INDEX IF NOT EXISTS ix_inventory_count_lines_review_status "
                "ON inventory_count_lines (review_status)"
            )
        )
        conn.commit()


def ensure_sqlite_pos_columns(target_engine=None):
    database_engine = target_engine or engine
    if database_engine.dialect.name != "sqlite":
        return
    from sqlalchemy import text

    with database_engine.connect() as conn:
        category_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(menu_categories)"))
        ]
        if category_columns and "display_order" not in category_columns:
            conn.execute(
                text(
                    "ALTER TABLE menu_categories "
                    "ADD COLUMN display_order INTEGER NOT NULL DEFAULT 0"
                )
            )

        order_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(pos_orders)"))
        ]
        additions = {
            "table_id": "INTEGER",
            "check_number": "INTEGER NOT NULL DEFAULT 1",
            "progress": "VARCHAR(30) NOT NULL DEFAULT 'FOOD_UNORDERED'",
            "subtotal_cents": "INTEGER NOT NULL DEFAULT 0",
            "tax_cents": "INTEGER NOT NULL DEFAULT 0",
            "tip_cents": "INTEGER NOT NULL DEFAULT 0",
            "total_cents": "INTEGER NOT NULL DEFAULT 0",
            "print_count": "INTEGER NOT NULL DEFAULT 0",
            "printed_at": "DATETIME",
            "closed_at": "DATETIME",
        }
        if order_columns:
            for name, sql_type in additions.items():
                if name not in order_columns:
                    conn.execute(
                        text(f"ALTER TABLE pos_orders ADD COLUMN {name} {sql_type}")
                    )
            conn.execute(
                text(
                    "CREATE INDEX IF NOT EXISTS ix_pos_orders_table_id "
                    "ON pos_orders (table_id)"
                )
            )

        pos_table_columns = [
            row[1] for row in conn.execute(text("PRAGMA table_info(pos_tables)"))
        ]
        if pos_table_columns:
            if "client_request_id" not in pos_table_columns:
                conn.execute(
                    text(
                        "ALTER TABLE pos_tables "
                        "ADD COLUMN client_request_id VARCHAR(64)"
                    )
                )
            conn.execute(
                text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS "
                    "ix_pos_tables_client_request_id "
                    "ON pos_tables (client_request_id)"
                )
            )
        conn.commit()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
