from datetime import date, datetime, timedelta

import pytest

from app.models import (
    EmployeeRole,
    POSTable,
    POSTableEvent,
    POSTableStatus,
    POSTerminalSession,
    UserRole,
)


async def login_web_manager(client):
    email = "pos-web-manager@example.com"
    await client.post(
        "/auth/register",
        json={
            "email": email,
            "password": "secret123",
            "full_name": "POS Web Manager",
            "role": UserRole.MANAGER.value,
        },
    )
    response = await client.post(
        "/auth/login",
        json={"email": email, "password": "secret123"},
    )
    return {"Authorization": f"Bearer {response.json()['access_token']}"}


async def create_employee(client, headers, first_name, role=EmployeeRole.SERVER):
    response = await client.post(
        "/employees",
        headers=headers,
        json={
            "first_name": first_name,
            "last_name": "POS Test",
            "role": role.value,
            "employment_start_date": date.today().isoformat(),
            "active": True,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


@pytest.mark.asyncio
async def test_pos_server_and_manager_table_lifecycle(
    client, TestingSessionLocal
):
    headers = await login_web_manager(client)
    server = await create_employee(client, headers, "Terminal Server")
    other_server = await create_employee(client, headers, "Transfer Server")
    manager = await create_employee(
        client, headers, "Terminal Manager", EmployeeRole.OTHER
    )

    for employee, number, access_role in (
        (server, "7314", "SERVER"),
        (other_server, "7315", "SERVER"),
        (manager, "97314", "MANAGER"),
    ):
        configured = await client.put(
            f"/pos/admin/access/{employee['id']}",
            headers=headers,
            json={
                "employee_number": number,
                "access_role": access_role,
                "active": True,
            },
        )
        assert configured.status_code == 200, configured.text
        assert configured.json()["has_employee_number"] is True
        assert "employee_number" not in configured.json()

    duplicate = await client.put(
        f"/pos/admin/access/{manager['id']}",
        headers=headers,
        json={
            "employee_number": "7314",
            "access_role": "MANAGER",
            "active": True,
        },
    )
    assert duplicate.status_code == 409

    logged_in = await client.post(
        "/pos/pin/login", json={"employee_number": "7314"}
    )
    assert logged_in.status_code == 200, logged_in.text
    assert logged_in.json()["employee"]["access_role"] == "SERVER"
    assert logged_in.json()["idle_timeout_seconds"] == 45
    assert "httponly" in logged_in.headers["set-cookie"].lower()
    assert "samesite=strict" in logged_in.headers["set-cookie"].lower()

    bootstrap = await client.get("/pos/terminal/bootstrap")
    assert bootstrap.status_code == 200, bootstrap.text
    assert bootstrap.json()["permissions"]["view_all_tables"] is False
    assert bootstrap.json()["features"]["menu_items"] is False
    assert [row["name"] for row in bootstrap.json()["categories"]] == [
        "Drinks",
        "Apps",
        "Apps as Meal",
        "Salads",
        "Steaks",
        "Chicken",
        "Ribs",
        "Combos",
        "Prime",
        "Special",
        "Seafood",
    ]

    create_payload = {
        "table_number": 912,
        "client_request_id": "pos-test-create-912",
    }
    created = await client.post("/pos/terminal/tables", json=create_payload)
    repeated = await client.post("/pos/terminal/tables", json=create_payload)
    assert created.status_code == 201, created.text
    assert repeated.status_code == 201, repeated.text
    assert repeated.json()["id"] == created.json()["id"]
    assert created.json()["check"]["total_cents"] == 0
    assert created.json()["progress"] == "FOOD_UNORDERED"

    duplicate_table = await client.post(
        "/pos/terminal/tables",
        json={"table_number": 912, "client_request_id": "duplicate-912"},
    )
    assert duplicate_table.status_code == 409

    denied_transfer = await client.post(
        f"/pos/terminal/tables/{created.json()['id']}/transfer",
        json={
            "owner_employee_id": other_server["id"],
            "revision": created.json()["revision"],
        },
    )
    assert denied_transfer.status_code == 403

    printed = await client.post(
        f"/pos/terminal/checks/{created.json()['check']['id']}/print"
    )
    assert printed.status_code == 200, printed.text
    assert printed.json()["print_count"] == 1
    print_view = await client.get(printed.json()["print_url"])
    assert print_view.status_code == 200
    assert "Table</span><strong>912" in print_view.text
    assert "Training Check" in print_view.text

    closed = await client.post(
        f"/pos/terminal/checks/{created.json()['check']['id']}/close-empty",
        json={"revision": created.json()["revision"]},
    )
    assert closed.status_code == 200, closed.text
    assert closed.json()["status"] == "CLOSED"
    assert closed.json()["progress"] == "CHECK_PAID"
    assert (await client.get("/pos/terminal/tables")).json() == []

    await client.post("/pos/pin/logout")
    manager_login = await client.post(
        "/pos/pin/login", json={"employee_number": "97314"}
    )
    assert manager_login.status_code == 200, manager_login.text
    manager_bootstrap = await client.get("/pos/terminal/bootstrap")
    assert manager_bootstrap.json()["permissions"]["view_all_tables"] is True
    assert len(manager_bootstrap.json()["transfer_candidates"]) >= 2

    manager_table = await client.post(
        "/pos/terminal/tables",
        json={
            "table_number": 913,
            "client_request_id": "pos-test-create-913",
        },
    )
    transferred = await client.post(
        f"/pos/terminal/tables/{manager_table.json()['id']}/transfer",
        json={
            "owner_employee_id": other_server["id"],
            "revision": manager_table.json()["revision"],
        },
    )
    assert transferred.status_code == 200, transferred.text
    assert transferred.json()["owner_employee_id"] == other_server["id"]
    assert transferred.json()["revision"] == manager_table.json()["revision"] + 1

    stale = await client.post(
        f"/pos/terminal/tables/{manager_table.json()['id']}/transfer",
        json={
            "owner_employee_id": server["id"],
            "revision": manager_table.json()["revision"],
        },
    )
    assert stale.status_code == 409
    manager_tables = await client.get("/pos/terminal/tables")
    assert [row["table_number"] for row in manager_tables.json()] == [913]

    with TestingSessionLocal() as db:
        archived = (
            db.query(POSTable)
            .filter(POSTable.table_number == 912)
            .one()
        )
        assert archived.status == POSTableStatus.CLOSED
        assert archived.active_number_key is None
        event_types = {
            value
            for (value,) in db.query(POSTableEvent.event_type)
            .filter(POSTableEvent.table_id == archived.id)
            .all()
        }
        assert event_types == {
            "TABLE_OPENED",
            "CHECK_PRINTED",
            "EMPTY_CHECK_CLOSED",
        }
        active_session = (
            db.query(POSTerminalSession)
            .filter(POSTerminalSession.revoked_at.is_(None))
            .order_by(POSTerminalSession.id.desc())
            .first()
        )
        active_session.last_seen_at = datetime.utcnow() - timedelta(seconds=46)
        db.commit()

    assert (await client.get("/pos/pin/session")).status_code == 401


@pytest.mark.asyncio
async def test_pos_pin_validation_and_logout(client):
    invalid = await client.post(
        "/pos/pin/login", json={"employee_number": "12"}
    )
    assert invalid.status_code == 422
    assert (await client.get("/pos/pin/session")).status_code == 401

    logout = await client.post("/pos/pin/logout")
    assert logout.status_code == 204
