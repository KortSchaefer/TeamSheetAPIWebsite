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

    dashboard = await client.get("/inventory/dashboard", headers=headers)
    assert dashboard.status_code == 200, dashboard.text
    assert dashboard.json()["item_count"] >= 1
    assert dashboard.json()["location_count"] >= 1
    assert dashboard.json()["low_stock_count"] >= 0


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


@pytest.mark.asyncio
async def test_purchase_order_csv_preview_import_and_duplicate_protection(client):
    token = await login_manager(client, "po-import@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    vendor = await client.post(
        "/inventory/vendors",
        json={"name": "CSV Import Vendor", "lead_time_days": 2},
        headers=headers,
    )
    assert vendor.status_code == 201, vendor.text
    vendor_id = vendor.json()["id"]
    location = await client.post(
        "/inventory/locations", json={"name": "CSV Import Storage"}, headers=headers
    )
    location_id = location.json()["id"]
    sku_item = await client.post(
        "/inventory/items",
        json={"name": "CSV Vodka Case", "sku": "HOUSE-100", "base_unit": "case"},
        headers=headers,
    )
    named_item = await client.post(
        "/inventory/items",
        json={"name": "CSV Lime Juice", "base_unit": "bottle"},
        headers=headers,
    )
    assert sku_item.status_code == 201 and named_item.status_code == 201
    sku_item_id = sku_item.json()["id"]
    named_item_id = named_item.json()["id"]
    vendor_item = await client.post(
        "/inventory/vendor-items",
        json={
            "vendor_id": vendor_id,
            "inventory_item_id": sku_item_id,
            "vendor_sku": "V-100",
            "unit_price_cents": 1250,
        },
        headers=headers,
    )
    assert vendor_item.status_code == 201, vendor_item.text
    await client.put(
        f"/inventory/items/{sku_item_id}/balances",
        json={"location_id": location_id},
        headers=headers,
    )
    await client.post(
        "/inventory/movements",
        json={
            "inventory_item_id": sku_item_id,
            "location_id": location_id,
            "quantity_change": 4,
            "reason": "OPENING",
            "source_event_key": "po-import-test-opening",
        },
        headers=headers,
    )

    csv_text = (
        "Product Code,Description,Qty,Unit Cost ($),PO Number\n"
        "V-100,Vendor wording for vodka,2,$12.50,PO-8842\n"
        ",CSV Lime Juice,3,4.25,PO-8842\n"
        ",Mystery bar supply,1,2.00,PO-8842\n"
    )
    preview_payload = {
        "vendor_id": vendor_id,
        "csv_text": csv_text,
        "source_filename": "vendor-order.csv",
    }
    preview = await client.post(
        "/inventory/purchase-orders/import-preview", json=preview_payload, headers=headers
    )
    assert preview.status_code == 200, preview.text
    preview_data = preview.json()
    assert preview_data["matched_count"] == 2
    assert preview_data["unresolved_count"] == 1
    assert preview_data["external_reference"] == "PO-8842"
    assert preview_data["rows"][0]["match_method"] == "vendor SKU"
    assert preview_data["rows"][0]["unit_price_cents"] == 1250

    import_payload = {
        **preview_payload,
        "item_overrides": {"4": named_item_id},
        "notes": "Imported in test",
    }
    imported = await client.post(
        "/inventory/purchase-orders/import-csv", json=import_payload, headers=headers
    )
    assert imported.status_code == 201, imported.text
    imported_data = imported.json()
    assert imported_data["status"] == "DRAFT"
    assert imported_data["external_reference"] == "PO-8842"
    assert imported_data["imported_filename"] == "vendor-order.csv"
    assert len(imported_data["lines"]) == 3

    stock = await client.get(f"/inventory/stock?location_id={location_id}", headers=headers)
    sku_stock = next(row for row in stock.json() if row["inventory_item_id"] == sku_item_id)
    assert Decimal(sku_stock["quantity_on_hand"]) == 4

    duplicate = await client.post(
        "/inventory/purchase-orders/import-csv", json=import_payload, headers=headers
    )
    assert duplicate.status_code == 409
    assert "already imported" in duplicate.json()["detail"]


@pytest.mark.asyncio
async def test_weekday_planner_vendor_split_incoming_and_bulk_receiving(client):
    token = await login_manager(client, "planning-manager@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    location = await client.post(
        "/inventory/locations", json={"name": "Planning Walk-in"}, headers=headers
    )
    location_id = location.json()["id"]
    vendors = []
    for name in ("Planning Produce Vendor", "Planning Dairy Vendor"):
        response = await client.post(
            "/inventory/vendors", json={"name": name}, headers=headers
        )
        assert response.status_code == 201, response.text
        vendors.append(response.json())
    items = []
    for name in ("Planning Lettuce", "Planning Cheese"):
        response = await client.post(
            "/inventory/items",
            json={"name": name, "base_unit": "each", "purchase_unit": "case"},
            headers=headers,
        )
        assert response.status_code == 201, response.text
        items.append(response.json())

    settings = await client.put(
        "/inventory/settings/targets",
        json={
            "location_id": location_id,
            "rows": [
                {
                    "inventory_item_id": items[0]["id"],
                    "planning_active": True,
                    "weekday_targets": {"2": 10},
                    "lower_tolerance_percent": 5,
                    "upper_tolerance_percent": 5,
                    "preferred_vendor_id": vendors[0]["id"],
                    "purchase_unit": "case",
                    "pack_quantity": 4,
                    "unit_price_cents": 1000,
                },
                {
                    "inventory_item_id": items[1]["id"],
                    "planning_active": True,
                    "weekday_targets": {"2": 8},
                    "preferred_vendor_id": vendors[1]["id"],
                    "purchase_unit": "case",
                    "pack_quantity": 3,
                    "unit_price_cents": 1500,
                },
            ],
        },
        headers=headers,
    )
    assert settings.status_code == 200, settings.text
    configured = {
        row["inventory_item_id"]: row
        for row in settings.json()["rows"]
        if row["inventory_item_id"] in {item["id"] for item in items}
    }
    assert configured[items[0]["id"]]["weekday_targets"]["2"] == "10.0000"
    assert configured[items[0]["id"]]["effective_lower_tolerance_percent"] == "5.00"

    count = await client.post(
        "/inventory/counts",
        json={
            "location_id": location_id,
            "lines": [
                {"inventory_item_id": items[0]["id"], "counted_quantity": 2},
                {"inventory_item_id": items[1]["id"], "counted_quantity": 1},
            ],
        },
        headers=headers,
    )
    await client.post(f"/inventory/counts/{count.json()['id']}/submit", headers=headers)
    posted = await client.post(
        f"/inventory/counts/{count.json()['id']}/post", headers=headers
    )
    assert posted.status_code == 200, posted.text

    planner_url = (
        f"/inventory/purchase-order-planner?location_id={location_id}"
        "&delivery_date=2026-08-05"
    )
    planner = await client.get(planner_url, headers=headers)
    assert planner.status_code == 200, planner.text
    planning_rows = {
        row["inventory_item_id"]: row for row in planner.json()["rows"]
    }
    assert planning_rows[items[0]["id"]]["counted_quantity"] == "2.0000"
    assert planning_rows[items[0]["id"]]["expected_quantity"] == "2.0000"
    assert planning_rows[items[0]["id"]]["recommended_purchase_quantity"] == "2"
    assert planning_rows[items[1]["id"]]["recommended_purchase_quantity"] == "3"

    created = await client.post(
        "/inventory/purchase-orders/from-plan",
        json={
            "expected_date": "2026-08-05",
            "lines": [
                {
                    "inventory_item_id": items[0]["id"],
                    "location_id": location_id,
                    "purchase_quantity": 2,
                },
                {
                    "inventory_item_id": items[1]["id"],
                    "location_id": location_id,
                    "purchase_quantity": 3,
                },
            ],
        },
        headers=headers,
    )
    assert created.status_code == 201, created.text
    orders = created.json()
    assert len(orders) == 2
    assert {order["vendor_id"] for order in orders} == {vendor["id"] for vendor in vendors}

    draft_planner = await client.get(planner_url, headers=headers)
    assert all(Decimal(row["incoming_quantity"]) == 0 for row in draft_planner.json()["rows"])
    for order in orders:
        submitted = await client.post(
            f"/inventory/purchase-orders/{order['id']}/submit", headers=headers
        )
        assert submitted.status_code == 200, submitted.text
    incoming_planner = await client.get(planner_url, headers=headers)
    incoming_rows = {
        row["inventory_item_id"]: row for row in incoming_planner.json()["rows"]
    }
    assert Decimal(incoming_rows[items[0]["id"]]["incoming_quantity"]) == 8
    assert Decimal(incoming_rows[items[1]["id"]]["incoming_quantity"]) == 9

    produce_order = next(order for order in orders if order["vendor_id"] == vendors[0]["id"])
    order_line = produce_order["lines"][0]
    received = await client.post(
        "/inventory/receiving",
        json={
            "purchase_order_id": produce_order["id"],
            "invoice_number": "PLAN-RECEIPT-1",
            "lines": [
                {
                    "purchase_order_line_id": order_line["id"],
                    "inventory_item_id": items[0]["id"],
                    "location_id": location_id,
                    "received_quantity": 2,
                    "unit_price_cents": 1000,
                }
            ],
        },
        headers=headers,
    )
    assert received.status_code == 201, received.text
    assert received.json()["status"] == "RECEIVED"
    final_planner = await client.get(planner_url, headers=headers)
    final_row = next(
        row for row in final_planner.json()["rows"] if row["inventory_item_id"] == items[0]["id"]
    )
    assert Decimal(final_row["counted_quantity"]) == 2
    assert Decimal(final_row["expected_quantity"]) == 10
    assert Decimal(final_row["incoming_quantity"]) == 0


@pytest.mark.asyncio
async def test_inventory_dashboard_analytics(client):
    token = await login_manager(client, "inventory-dashboard@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    location = await client.post(
        "/inventory/locations",
        json={"name": "Dashboard Cooler"},
        headers=headers,
    )
    location_id = location.json()["id"]

    protein = await client.post(
        "/inventory/items",
        json={
            "name": "Dashboard Steak",
            "category": "Dashboard Protein",
            "base_unit": "each",
            "default_location_id": location_id,
            "cost_cents": 250,
        },
        headers=headers,
    )
    produce = await client.post(
        "/inventory/items",
        json={
            "name": "Dashboard Limes",
            "category": "Dashboard Produce",
            "base_unit": "each",
            "default_location_id": location_id,
            "cost_cents": 100,
        },
        headers=headers,
    )
    protein_id = protein.json()["id"]
    produce_id = produce.json()["id"]
    for item_id, minimum, par, received in (
        (protein_id, 5, 10, 2),
        (produce_id, 1, 5, 5),
    ):
        await client.put(
            f"/inventory/items/{item_id}/balances",
            json={
                "location_id": location_id,
                "minimum_quantity": minimum,
                "par_quantity": par,
            },
            headers=headers,
        )
        await client.post(
            "/inventory/movements",
            json={
                "inventory_item_id": item_id,
                "location_id": location_id,
                "quantity_change": received,
                "reason": "DASHBOARD_TEST_RECEIVE",
                "source_event_key": f"dashboard-receive-{item_id}",
            },
            headers=headers,
        )

    sheet = await client.post(
        "/inventory/count-sheets",
        json={"location_id": location_id, "resume_existing": False},
        headers=headers,
    )
    assert sheet.status_code == 201, sheet.text
    protein_line = next(
        row
        for row in sheet.json()["lines"]
        if row["inventory_item_id"] == protein_id
    )
    edited = await client.post(
        f"/inventory/count-sheets/{sheet.json()['id']}/lines/batch",
        json={
            "edits": [
                {
                    "line_id": protein_line["id"],
                    "counted_quantity": 1,
                    "source": "MANUAL",
                    "client_revision": protein_line["revision"],
                }
            ]
        },
        headers=headers,
    )
    assert edited.status_code == 200, edited.text

    dashboard = await client.get("/inventory/dashboard", headers=headers)
    assert dashboard.status_code == 200, dashboard.text
    payload = dashboard.json()

    categories = {row["category"]: row for row in payload["category_values"]}
    assert categories["Dashboard Protein"]["value_cents"] == 500
    assert categories["Dashboard Produce"]["value_cents"] == 500

    low_item = next(
        row
        for row in payload["low_stock_items"]
        if row["inventory_item_id"] == protein_id
    )
    assert Decimal(str(low_item["order_quantity"])) == 8
    assert low_item["estimated_cost_cents"] == 2000
    assert low_item["status"] == "LOW"

    completion = next(
        row
        for row in payload["count_completion"]
        if row["location_id"] == location_id
    )
    assert completion["total_lines"] == 2
    assert completion["counted_lines"] == 1
    assert completion["uncounted_lines"] == 1
    assert completion["completion_percent"] == 50.0

    variance = next(
        row
        for row in payload["largest_variances"]
        if row["inventory_item_id"] == protein_id
    )
    assert Decimal(str(variance["variance_quantity"])) == -1
    assert variance["variance_value_cents"] == -250


@pytest.mark.asyncio
async def test_spreadsheet_count_sheet_batches_reviews_and_approves(client):
    token = await login_manager(client, "inventory-sheet@example.com")
    headers = {"Authorization": f"Bearer {token}"}
    location = await client.post(
        "/inventory/locations",
        json={"name": "Spreadsheet Walk-in"},
        headers=headers,
    )
    location_id = location.json()["id"]
    first = await client.post(
        "/inventory/items",
        json={
            "name": "Spreadsheet Chicken",
            "category": "Protein",
            "base_unit": "case",
            "default_location_id": location_id,
        },
        headers=headers,
    )
    second = await client.post(
        "/inventory/items",
        json={
            "name": "Spreadsheet Tomatoes",
            "category": "Produce",
            "base_unit": "lb",
            "default_location_id": location_id,
        },
        headers=headers,
    )
    assert first.status_code == second.status_code == 201

    created = await client.post(
        "/inventory/count-sheets",
        json={"location_id": location_id},
        headers=headers,
    )
    assert created.status_code == 201, created.text
    sheet = created.json()
    assert sheet["line_count"] == 2
    assert sheet["counted_line_count"] == 0
    assert all(row["counted_quantity"] is None for row in sheet["lines"])

    reversed_ids = [row["id"] for row in reversed(sheet["lines"])]
    reordered = await client.post(
        f"/inventory/count-sheets/{sheet['id']}/reorder",
        json={"line_ids": reversed_ids},
        headers=headers,
    )
    assert reordered.status_code == 200, reordered.text
    sheet = reordered.json()
    assert [row["id"] for row in sheet["lines"]] == reversed_ids

    template = await client.post(
        "/inventory/count-templates",
        json={
            "name": "Spreadsheet Walk-in Order",
            "lines": [
                {
                    "inventory_item_id": row["inventory_item_id"],
                    "location_id": location_id,
                    "display_order": index,
                    "preferred_unit": row["base_unit"],
                }
                for index, row in enumerate(sheet["lines"])
            ],
        },
        headers=headers,
    )
    assert template.status_code == 201, template.text
    assert [row["item_name"] for row in template.json()["lines"]] == [
        row["item_name"] for row in sheet["lines"]
    ]

    edits = [
        {
            "line_id": row["id"],
            "counted_quantity": index + 3,
            "source": "MANUAL",
            "client_revision": row["revision"],
        }
        for index, row in enumerate(sheet["lines"])
    ]
    updated = await client.post(
        f"/inventory/count-sheets/{sheet['id']}/lines/batch",
        json={"edits": edits},
        headers=headers,
    )
    assert updated.status_code == 200, updated.text
    assert updated.json()["counted_line_count"] == 2
    assert updated.json()["exception_count"] == 0

    stale = await client.patch(
        f"/inventory/count-sheets/{sheet['id']}/lines/{sheet['lines'][0]['id']}",
        json={
            "counted_quantity": 9,
            "source": "MANUAL",
            "client_revision": sheet["lines"][0]["revision"],
        },
        headers=headers,
    )
    assert stale.status_code == 409

    approved = await client.post(
        f"/inventory/count-sheets/{sheet['id']}/approve",
        headers=headers,
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "APPROVED"
    assert all(row["review_status"] == "APPROVED" for row in approved.json()["lines"])

    csv_export = await client.get(
        f"/inventory/count-sheets/{sheet['id']}/export.csv",
        headers=headers,
    )
    xlsx_export = await client.get(
        f"/inventory/count-sheets/{sheet['id']}/export.xlsx",
        headers=headers,
    )
    printable = await client.get(
        f"/inventory/count-sheets/{sheet['id']}/print",
        headers=headers,
    )
    assert csv_export.status_code == xlsx_export.status_code == printable.status_code == 200
    assert "Spreadsheet Chicken" in csv_export.text
    assert xlsx_export.content.startswith(b"PK")
    assert "Spreadsheet Walk-in Inventory Count" in printable.text

    templated_sheet = await client.post(
        "/inventory/count-sheets",
        json={
            "location_id": location_id,
            "template_id": template.json()["id"],
            "resume_existing": False,
        },
        headers=headers,
    )
    assert templated_sheet.status_code == 201, templated_sheet.text
    assert templated_sheet.json()["template_name"] == "Spreadsheet Walk-in Order"
    assert [row["item_name"] for row in templated_sheet.json()["lines"]] == [
        row["item_name"] for row in sheet["lines"]
    ]
