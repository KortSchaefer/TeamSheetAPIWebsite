import pytest
from decimal import Decimal

from app.models import UserRole


async def login_manager(client, email="inventory-manager@example.com"):
    await client.post(
        "/auth/register",
        json={"email": email, "password": "secret123", "full_name": "Inventory Manager", "role": UserRole.MANAGER.value},
    )
    response = await client.post("/auth/login", json={"email": email, "password": "secret123"})
    return response.json()["access_token"]


@pytest.mark.asyncio
async def test_inventory_location_item_movement_and_idempotency(client):
    token = await login_manager(client)
    headers = {"Authorization": f"Bearer {token}"}

    location = await client.post("/inventory/locations", json={"name": "Walk-in Test"}, headers=headers)
    assert location.status_code == 201, location.text
    location_id = location.json()["id"]

    item = await client.post(
        "/inventory/items",
        json={"name": "Test Chicken", "category": "Protein", "base_unit": "lb", "default_location_id": location_id},
        headers=headers,
    )
    assert item.status_code == 201, item.text
    item_id = item.json()["id"]

    balance = await client.put(
        f"/inventory/items/{item_id}/balances",
        json={"location_id": location_id, "minimum_quantity": 5, "par_quantity": 20},
        headers=headers,
    )
    assert balance.status_code == 200, balance.text

    movement_payload = {
        "inventory_item_id": item_id,
        "location_id": location_id,
        "quantity_change": 12,
        "reason": "RECEIVE",
        "source_event_key": "test-receive-1",
    }
    first = await client.post("/inventory/movements", json=movement_payload, headers=headers)
    duplicate = await client.post("/inventory/movements", json=movement_payload, headers=headers)
    assert first.status_code == 201
    assert duplicate.status_code == 201
    assert duplicate.json()["id"] == first.json()["id"]

    stock = await client.get(f"/inventory/stock?location_id={location_id}", headers=headers)
    assert stock.status_code == 200
    assert Decimal(stock.json()[0]["quantity_on_hand"]) == 12
    assert stock.json()[0]["status"] == "HEALTHY"


@pytest.mark.asyncio
async def test_inventory_count_posts_difference(client):
    token = await login_manager(client, "inventory-count@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    location = await client.post("/inventory/locations", json={"name": "Prep Test"}, headers=headers)
    item = await client.post("/inventory/items", json={"name": "Test Tomatoes", "base_unit": "lb"}, headers=headers)
    location_id = location.json()["id"]
    item_id = item.json()["id"]
    await client.put(f"/inventory/items/{item_id}/balances", json={"location_id": location_id, "par_quantity": 10}, headers=headers)

    count = await client.post(
        "/inventory/counts",
        json={"location_id": location_id, "lines": [{"inventory_item_id": item_id, "counted_quantity": 7}]},
        headers=headers,
    )
    assert count.status_code == 201, count.text
    submitted = await client.post(f"/inventory/counts/{count.json()['id']}/submit", headers=headers)
    assert submitted.status_code == 200
    posted = await client.post(f"/inventory/counts/{count.json()['id']}/post", headers=headers)
    assert posted.status_code == 200, posted.text

    stock = await client.get(f"/inventory/stock?location_id={location_id}", headers=headers)
    assert Decimal(stock.json()[0]["quantity_on_hand"]) == 7
