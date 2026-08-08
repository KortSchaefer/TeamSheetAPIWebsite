from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
if str(REPOSITORY_ROOT) not in sys.path:
    sys.path.insert(0, str(REPOSITORY_ROOT))

from app.main import create_app
from contracts.fastapi_contract import (
    CONTRACT_ROOT,
    build_route_inventory,
    canonical_json,
    capture_representative_fixtures,
    fixture_filename,
    render_route_inventory_markdown,
    write_contract_artifacts,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Export or verify the reference FastAPI API contract."
    )
    parser.add_argument(
        "--check",
        action="store_true",
        help="Fail if the committed contract differs from the current FastAPI app.",
    )
    return parser.parse_args()


async def expected_files() -> dict[Path, str]:
    app = create_app()
    inventory = build_route_inventory(app)
    fixtures = await capture_representative_fixtures()
    files = {
        CONTRACT_ROOT / "openapi.json": canonical_json(app.openapi()),
        CONTRACT_ROOT / "routes.json": canonical_json(inventory),
        CONTRACT_ROOT / "routes.md": render_route_inventory_markdown(inventory),
    }
    manifest = []
    for fixture in fixtures:
        filename = fixture_filename(fixture["id"])
        files[CONTRACT_ROOT / "fixtures" / filename] = canonical_json(fixture)
        manifest.append(
            {
                "id": fixture["id"],
                "file": filename,
                "description": fixture["description"],
            }
        )
    files[CONTRACT_ROOT / "fixtures" / "manifest.json"] = canonical_json(
        {"format_version": 1, "fixtures": manifest}
    )
    return files


async def main() -> int:
    args = parse_args()
    if not args.check:
        app = create_app()
        fixtures = await capture_representative_fixtures()
        write_contract_artifacts(app, fixtures)
        print(f"Exported FastAPI contract to {CONTRACT_ROOT}")
        return 0

    mismatches = []
    for path, expected in (await expected_files()).items():
        if not path.exists():
            mismatches.append(f"missing: {path}")
        elif path.read_text(encoding="utf-8") != expected:
            mismatches.append(f"changed: {path}")
    if mismatches:
        print("FastAPI contract snapshot is stale:")
        for mismatch in mismatches:
            print(f"- {mismatch}")
        return 1
    print("FastAPI contract snapshot is current.")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
