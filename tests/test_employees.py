import pytest

from app.models import UserRole


async def register_and_login(client, role=UserRole.MANAGER, email="manager@example.com"):
    await client.post(
        "/auth/register",
        json={"email": email, "password": "secret123", "full_name": "Manager One", "role": role},
    )
    resp = await client.post("/auth/login", json={"email": email, "password": "secret123"})
    data = resp.json()
    return data["access_token"]


@pytest.mark.asyncio
async def test_employee_crud_flow(client):
    token = await register_and_login(client)
    headers = {"Authorization": f"Bearer {token}"}

    create_resp = await client.post(
        "/employees",
        json={
            "first_name": "Alice",
            "last_name": "Server",
            "nickname": "Al",
            "role": "SERVER",
            "employment_start_date": "2023-01-01",
            "active": True,
        },
        headers=headers,
    )
    assert create_resp.status_code == 201, create_resp.text
    employee_id = create_resp.json()["id"]

    list_resp = await client.get("/employees", headers=headers)
    assert list_resp.status_code == 200
    assert any(emp["id"] == employee_id for emp in list_resp.json())

    update_resp = await client.put(
        f"/employees/{employee_id}",
        json={"nickname": "Ace", "upsell_score": 90},
        headers=headers,
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["nickname"] == "Ace"

    delete_resp = await client.delete(f"/employees/{employee_id}", headers=headers)
    assert delete_resp.status_code == 204

    detail_resp = await client.get(f"/employees/{employee_id}", headers=headers)
    assert detail_resp.json()["active"] is False
