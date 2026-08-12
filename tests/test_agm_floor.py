import uuid

import pytest


async def manager_headers(client):
    email = f"agm-{uuid.uuid4().hex}@example.com"
    registration = await client.post(
        "/auth/register",
        json={"email": email, "password": "secret123", "full_name": "AGM Test", "role": "MANAGER"},
    )
    assert registration.status_code == 201, registration.text
    login = await client.post("/auth/login", json={"email": email, "password": "secret123"})
    assert login.status_code == 200, login.text
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


def layout_payload():
    return {
        "name": "Main Floor",
        "canvas_width": 900,
        "canvas_height": 600,
        "areas": [{"name": "Dining", "shape": "ROUNDED", "x": 20, "y": 20, "width": 700, "height": 480}],
        "fixtures": [{"type": "TEXT", "text": "Host stand", "x": 30, "y": 30, "width": 96, "height": 96}],
        "tables": [
            {"table_number": "1", "label": "1", "capacity": 4, "shape": "ROUND", "x": 80, "y": 80},
            {"table_number": "2", "label": "2", "capacity": 6, "shape": "SQUARE", "x": 240, "y": 80},
        ],
    }


@pytest.mark.asyncio
async def test_agm_floor_service_lifecycle_and_revision_conflicts(client):
    headers = await manager_headers(client)
    bootstrap = await client.get("/agm/bootstrap", headers=headers)
    assert bootstrap.status_code == 200, bootstrap.text
    store_id = bootstrap.json()["stores"][0]["id"]
    assert bootstrap.json()["sms_provider"]["configured"] is False

    draft = await client.post(f"/agm/stores/{store_id}/layouts", json=layout_payload(), headers=headers)
    assert draft.status_code == 201, draft.text
    layout_id = draft.json()["id"]
    published = await client.post(f"/agm/layouts/{layout_id}/publish", json={}, headers=headers)
    assert published.status_code == 200, published.text
    assert published.json()["status"] == "PUBLISHED"

    immutable = await client.put(
        f"/agm/layouts/{layout_id}",
        json={**layout_payload(), "revision": published.json()["revision"]},
        headers=headers,
    )
    assert immutable.status_code == 409

    service = await client.post(
        f"/agm/stores/{store_id}/services",
        json={"layout_id": layout_id, "service_date": "2026-08-10", "name": "Dinner", "starts_at": "16:00", "ends_at": "23:00"},
        headers=headers,
    )
    assert service.status_code == 201, service.text
    service_id = service.json()["id"]

    party = await client.post(
        f"/agm/services/{service_id}/parties",
        json={"guest_name": "Jordan Guest", "phone": "+15555550199", "party_size": 4, "source": "WAITLIST", "quoted_minutes": 20, "sms_consent": True},
        headers=headers,
    )
    assert party.status_code == 201, party.text
    party_id = party.json()["id"]
    arrived = await client.patch(
        f"/agm/parties/{party_id}",
        json={"revision": party.json()["revision"], "status": "ARRIVED"},
        headers=headers,
    )
    assert arrived.status_code == 200, arrived.text

    seat = await client.post(
        f"/agm/services/{service_id}/commands",
        json={"command_id": "seat-party-0001", "expected_revision": 0, "type": "SEAT", "party_id": party_id, "table_numbers": ["1"]},
        headers=headers,
    )
    assert seat.status_code == 200, seat.text
    assert seat.json()["service_revision"] == 1

    replay = await client.post(
        f"/agm/services/{service_id}/commands",
        json={"command_id": "seat-party-0001", "expected_revision": 0, "type": "SEAT", "party_id": party_id, "table_numbers": ["1"]},
        headers=headers,
    )
    assert replay.status_code == 200
    assert replay.json()["service_revision"] == 1

    stale = await client.post(
        f"/agm/services/{service_id}/commands",
        json={"command_id": "move-party-stale", "expected_revision": 0, "type": "MOVE", "party_id": party_id, "table_numbers": ["2"]},
        headers=headers,
    )
    assert stale.status_code == 409

    move = await client.post(
        f"/agm/services/{service_id}/commands",
        json={"command_id": "move-party-0001", "expected_revision": 1, "type": "MOVE", "party_id": party_id, "table_numbers": ["2"]},
        headers=headers,
    )
    assert move.status_code == 200, move.text
    snapshot = await client.get(f"/agm/services/{service_id}/bootstrap", headers=headers)
    assert snapshot.json()["layout"]["areas"][0]["shape"] == "ROUNDED"
    assert snapshot.json()["layout"]["fixtures"][0]["text"] == "Host stand"
    states = {row["table_number"]: row for row in snapshot.json()["table_states"]}
    assert states["1"]["status"] == "AVAILABLE"
    assert states["2"]["party_id"] == party_id

    clear = await client.post(
        f"/agm/services/{service_id}/commands",
        json={"command_id": "clear-party-001", "expected_revision": 2, "type": "CLEAR", "party_id": party_id},
        headers=headers,
    )
    assert clear.status_code == 200, clear.text


@pytest.mark.asyncio
async def test_agm_floor_is_manager_only(client):
    email = f"server-{uuid.uuid4().hex}@example.com"
    await client.post(
        "/auth/register",
        json={"email": email, "password": "secret123", "full_name": "Server Test", "role": "SERVER"},
    )
    login = await client.post("/auth/login", json={"email": email, "password": "secret123"})
    response = await client.get("/agm/bootstrap", headers={"Authorization": f"Bearer {login.json()['access_token']}"})
    assert response.status_code == 403
