from __future__ import annotations

import json
import os
from pathlib import Path

import httpx
import pytest

from app.main import create_app
from contracts.fastapi_contract import (
    CONTRACT_ROOT,
    build_route_inventory,
    canonical_json,
    capture_representative_fixtures,
    load_fixtures,
    normalize_response,
    render_route_inventory_markdown,
)


def test_openapi_snapshot_matches_reference_application():
    actual = canonical_json(create_app().openapi())
    assert actual == (CONTRACT_ROOT / "openapi.json").read_text(encoding="utf-8")


def test_route_inventory_matches_reference_application():
    inventory = build_route_inventory(create_app())
    assert canonical_json(inventory) == (CONTRACT_ROOT / "routes.json").read_text(
        encoding="utf-8"
    )
    assert render_route_inventory_markdown(inventory) == (
        CONTRACT_ROOT / "routes.md"
    ).read_text(encoding="utf-8")


def test_route_inventory_schema_references_exist_in_openapi():
    openapi = json.loads((CONTRACT_ROOT / "openapi.json").read_text(encoding="utf-8"))
    inventory = json.loads((CONTRACT_ROOT / "routes.json").read_text(encoding="utf-8"))
    schemas = set(openapi.get("components", {}).get("schemas", {}))
    referenced = {
        reference
        for operation in inventory["operations"]
        for reference in (
            operation["request"]["schema_refs"]
            + operation["response_schema_refs"]
        )
    }
    assert referenced <= schemas
    assert inventory["operation_count"] == len(inventory["operations"])


@pytest.mark.asyncio
async def test_representative_fastapi_responses_match_fixtures():
    assert await capture_representative_fixtures() == load_fixtures()


@pytest.mark.asyncio
async def test_selected_worker_responses_can_match_same_fixtures():
    base_url = os.getenv("WORKER_CONTRACT_BASE_URL")
    if not base_url:
        pytest.skip("Set WORKER_CONTRACT_BASE_URL to compare a running Worker.")

    selected_ids = {
        value.strip()
        for value in os.getenv("WORKER_CONTRACT_FIXTURE_IDS", "health_success").split(",")
        if value.strip()
    }
    fixtures = [
        fixture
        for fixture in load_fixtures()
        if fixture["id"] in selected_ids and fixture["request"]["auth"] == "public"
    ]
    assert fixtures, "No selected public fixtures can be exercised against the Worker."

    async with httpx.AsyncClient(base_url=base_url) as client:
        for fixture in fixtures:
            request = fixture["request"]
            response = await client.request(
                request["method"], request["path"], json=request.get("json")
            )
            assert normalize_response(response) == fixture["response"], fixture["id"]

