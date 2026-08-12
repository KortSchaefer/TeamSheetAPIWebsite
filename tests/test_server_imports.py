import io

import pytest

from app.models import UserRole


async def register_and_login(client, email: str) -> str:
    await client.post(
        "/auth/register",
        json={"email": email, "password": "secret123", "full_name": "Import Manager", "role": UserRole.MANAGER},
    )
    response = await client.post("/auth/login", json={"email": email, "password": "secret123"})
    return response.json()["access_token"]


@pytest.mark.asyncio
async def test_server_csv_import_accepts_blast_header_and_percent_value(client):
    token = await register_and_login(client, "blast-import-manager@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    csv_data = "name,BLAST %,max_guests\nCasey Blast,112%,16\n"

    imported = await client.post(
        "/imports/servers",
        headers=headers,
        files={"file": ("servers.csv", io.BytesIO(csv_data.encode("utf-8")), "text/csv")},
    )
    assert imported.status_code == 201, imported.text
    assert imported.json() == {"created": 1, "updated": 0}

    roster = await client.get("/employees?role=SERVER&active=true", headers=headers)
    employee = next(item for item in roster.json() if item["first_name"] == "Casey")
    assert employee["upsell_score"] == 112
    assert employee["max_section_load"] == 16
