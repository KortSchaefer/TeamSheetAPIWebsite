import pytest

from app.models import UserRole


async def register_and_login(client, email="manager2@example.com"):
    await client.post(
        "/auth/register",
        json={"email": email, "password": "secret123", "full_name": "Manager Two", "role": UserRole.MANAGER.value},
    )
    resp = await client.post("/auth/login", json={"email": email, "password": "secret123"})
    return resp.json()["access_token"]


@pytest.mark.asyncio
async def test_team_sheet_create_and_export(client):
    token = await register_and_login(client)
    headers = {"Authorization": f"Bearer {token}"}

    # Create supporting data
    emp_resp = await client.post(
        "/employees",
        json={
            "first_name": "Bob",
            "last_name": "Builder",
            "role": "SERVER",
            "employment_start_date": "2023-01-01",
            "active": True,
        },
        headers=headers,
    )
    employee_id = emp_resp.json()["id"]

    section_resp = await client.post(
        "/sections",
        json={"name": "Floor 1", "label": "F1", "type": "FLOOR", "max_guests": 20, "is_active": True},
        headers=headers,
    )
    section_id = section_resp.json()["id"]

    shift_resp = await client.post(
        "/shifts",
        json={"date": "2024-05-01", "time_period": "DINNER"},
        headers=headers,
    )
    shift_id = shift_resp.json()["id"]

    create_payload = {
        "shift_id": shift_id,
        "title": "Dinner Shift",
        "status": "DRAFT",
        "notes": "Busy night",
        "assignments": [
            {"employee_id": employee_id, "section_id": section_id, "role_label": "Floor", "order_index": 1}
        ],
        "sidework": [
            {"label": "Salads", "description": "Prep salads", "employee_ids": [employee_id]},
        ],
        "outwork": [
            {"label": "Close patio", "description": "Clean tables", "employee_ids": [employee_id]},
        ],
    }

    team_resp = await client.post("/team-sheets", json=create_payload, headers=headers)
    assert team_resp.status_code == 201, team_resp.text
    team_sheet_id = team_resp.json()["id"]

    detail_resp = await client.get(f"/team-sheets/{team_sheet_id}", headers=headers)
    assert detail_resp.status_code == 200
    assert detail_resp.json()["assignments"][0]["employee_id"] == employee_id

    export_resp = await client.get(f"/team-sheets/{team_sheet_id}/export/csv", headers=headers)
    assert export_resp.status_code == 200
    assert "text/csv" in export_resp.headers["content-type"]
