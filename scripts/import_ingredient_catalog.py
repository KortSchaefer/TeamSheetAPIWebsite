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
from app.services.ingredient_catalog import (
    DEFAULT_CATALOG_PATH,
    import_catalog,
    load_catalog_file,
)


def main():
    parser = argparse.ArgumentParser(
        description="Validate and idempotently import an ingredient catalog."
    )
    parser.add_argument(
        "path",
        nargs="?",
        type=Path,
        default=DEFAULT_CATALOG_PATH,
        help="Catalog JSON path (defaults to data/ingredient_catalog.json)",
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
        result = import_catalog(
            db,
            load_catalog_file(args.path),
            source_name=args.path.name,
            dry_run=args.dry_run,
        )
    print(json.dumps(result, indent=2))


if __name__ == "__main__":
    main()
