import argparse
import json
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from app.database import (
    Base,
    SessionLocal,
    engine,
    ensure_sqlite_catalog_columns,
    ensure_sqlite_inventory_columns,
)
from app.services.ingredient_catalog import activate_bar_inventory


def main():
    parser = argparse.ArgumentParser(
        description="Import the bundled catalog and activate countable bar inventory."
    )
    parser.add_argument(
        "--location",
        default="Bar",
        help="Inventory location to create or reuse (default: Bar)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate and report counts without modifying the database",
    )
    args = parser.parse_args()

    Base.metadata.create_all(bind=engine)
    ensure_sqlite_inventory_columns()
    ensure_sqlite_catalog_columns()
    with SessionLocal() as db:
        result = activate_bar_inventory(
            db,
            location_name=args.location,
            dry_run=args.dry_run,
        )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
