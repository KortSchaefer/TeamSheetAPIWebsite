from datetime import date

import pytest

from app.models import POSTable, POSTableStatus


async def manager_headers(client):
    email = "pos-config-manager@example.com"
    await client.post(
        "/auth/register",
        json={"email": email, "password": "secret123", "full_name": "POS Config Manager", "role": "MANAGER"},
    )
    login = await client.post("/auth/login", json={"email": email, "password": "secret123"})
    return {"Authorization": f"Bearer {login.json()['access_token']}"}


@pytest.mark.asyncio
async def test_pos_configuration_inheritance_layout_audit_and_order_entry(client, TestingSessionLocal):
    headers = await manager_headers(client)
    bootstrap = await client.get("/pos/admin/config/bootstrap", headers=headers)
    assert bootstrap.status_code == 200, bootstrap.text
    page_id = bootstrap.json()["pages"][0]["id"]
    assert bootstrap.json()["permissions"]["pos.edit"] is True

    group = await client.post(
        "/pos/admin/config/modifier-groups",
        headers=headers,
        json={
            "slug": "steak-temperature",
            "name": "Steak Temperature",
            "prompt": "Choose a temperature",
            "required": True,
            "minimum_selections": 1,
            "maximum_selections": 1,
            "modifiers": [
                {"internal_key": "rare", "name": "Rare", "display_order": 1},
                {"internal_key": "medium", "name": "Medium", "display_order": 2},
            ],
        },
    )
    assert group.status_code == 201, group.text
    group_id = group.json()["id"]
    medium_id = next(row["id"] for row in group.json()["modifiers"] if row["internal_key"] == "medium")

    tag = await client.post(
        "/pos/admin/config/tags",
        headers=headers,
        json={
            "slug": "steak",
            "name": "Steak",
            "color": "#8b5a2b",
            "behavior": {"kitchen_station": "grill"},
            "modifier_groups": [{"id": group_id, "display_order": 1}],
        },
    )
    assert tag.status_code == 201, tag.text
    tag_id = next(row["id"] for row in tag.json() if row["slug"] == "steak")

    button = await client.post(
        "/pos/admin/config/buttons",
        headers=headers,
        json={
            "internal_key": "sirloin-6oz",
            "name": "6 oz Sirloin",
            "display_name": "6oz Sirloin",
            "description": "Six ounce hand-cut sirloin steak",
            "page_id": page_id,
            "price_cents": 1499,
            "weight_value": 6,
            "weight_unit": "oz",
            "tag_ids": [tag_id],
            "visual": {"type": "text", "background_color": "#55351f", "text_color": "#ffffff"},
            "grid_row": 2,
            "grid_column": 3,
        },
    )
    assert button.status_code == 201, button.text
    button_data = button.json()
    assert button_data["tags"] == ["steak"]
    assert button_data["modifier_groups"][0]["slug"] == "steak-temperature"
    assert button_data["modifier_groups"][0]["source"] == "tag:steak"

    layout = await client.put(
        "/pos/admin/config/layout",
        headers=headers,
        json={"entries": [{"button_id": button_data["id"], "page_id": page_id, "grid_row": 3, "grid_column": 1, "revision": button_data["revision"]}]},
    )
    assert layout.status_code == 200, layout.text
    stale = await client.put(
        "/pos/admin/config/layout",
        headers=headers,
        json={"entries": [{"button_id": button_data["id"], "page_id": page_id, "grid_row": 4, "grid_column": 1, "revision": button_data["revision"]}]},
    )
    assert stale.status_code == 409

    employee = await client.post(
        "/employees",
        headers=headers,
        json={"first_name": "Config", "last_name": "Server", "role": "SERVER", "employment_start_date": date.today().isoformat(), "active": True},
    )
    assert employee.status_code == 201, employee.text
    access = await client.put(
        f"/pos/admin/access/{employee.json()['id']}",
        headers=headers,
        json={"employee_number": "61944", "access_role": "SERVER", "active": True},
    )
    assert access.status_code == 200, access.text
    assert (await client.post("/pos/pin/login", json={"employee_number": "61944"})).status_code == 200
    terminal = await client.get("/pos/terminal/bootstrap")
    resolved = next(row for row in terminal.json()["menu_config"]["buttons"] if row["id"] == button_data["id"])
    assert resolved["modifier_groups"][0]["required"] is True

    table = await client.post("/pos/terminal/tables", json={"table_number": 614, "client_request_id": "pos-config-table-614"})
    assert table.status_code == 201, table.text
    missing_modifier = await client.post(
        f"/pos/terminal/checks/{table.json()['check']['id']}/items",
        json={"button_id": button_data["id"], "quantity": 1, "modifiers": []},
    )
    assert missing_modifier.status_code == 422
    added = await client.post(
        f"/pos/terminal/checks/{table.json()['check']['id']}/items",
        json={"button_id": button_data["id"], "quantity": 2, "modifiers": [{"modifier_id": medium_id}]},
    )
    assert added.status_code == 201, added.text
    assert added.json()["check"]["total_cents"] == 2998
    assert added.json()["check"]["items"][0]["configuration"]["button_revision"] >= 1

    audit = await client.get("/pos/admin/config/audit", headers=headers)
    assert {row["action"] for row in audit.json()} >= {"BUTTON_CREATED", "BUTTON_MOVED", "TAG_CREATED"}
    exported = await client.get("/pos/admin/config/export", headers=headers)
    assert exported.status_code == 200
    preview = await client.post("/pos/admin/config/import", headers=headers, json={"config": exported.json(), "preview": True})
    assert preview.status_code == 200, preview.text
    assert preview.json()["valid"] is True
    applied = await client.post("/pos/admin/config/import", headers=headers, json={"config": exported.json(), "preview": False})
    assert applied.status_code == 200, applied.text
    assert applied.json()["applied"]["buttons"] >= 1
    assert applied.json()["warnings"]

    with TestingSessionLocal() as db:
        open_table = db.query(POSTable).filter(POSTable.table_number == 614).one()
        open_table.status = POSTableStatus.CLOSED
        open_table.active_number_key = None
        db.commit()


@pytest.mark.asyncio
async def test_pos_configuration_requires_manager(client):
    email = "pos-config-server@example.com"
    await client.post("/auth/register", json={"email": email, "password": "secret123", "full_name": "POS Config Server", "role": "SERVER"})
    login = await client.post("/auth/login", json={"email": email, "password": "secret123"})
    response = await client.get("/pos/admin/config/bootstrap", headers={"Authorization": f"Bearer {login.json()['access_token']}"})
    assert response.status_code == 403
