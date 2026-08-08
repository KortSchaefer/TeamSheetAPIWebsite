import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { strFromU8, unzipSync } from "fflate";
import { beforeEach, describe, expect, it } from "vitest";

type D1TestEnv = Env & { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
const testEnv = env as D1TestEnv;
const PASSWORD = "worker-compatibility-fixture";
const HASH = "$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc";

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const login = await exports.default.fetch("https://example.test/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "inventory.manager@example.com", password: PASSWORD }),
  });
  const token = await login.json<{ access_token: string }>();
  return exports.default.fetch(`https://example.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token.access_token}`, ...(init.headers ?? {}) },
  });
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.exec("DELETE FROM inventory_receiving_lines; DELETE FROM inventory_receiving; DELETE FROM inventory_purchase_order_lines; DELETE FROM inventory_purchase_orders; DELETE FROM inventory_count_lines; DELETE FROM inventory_counts; DELETE FROM inventory_count_template_lines; DELETE FROM inventory_count_templates; DELETE FROM inventory_weekday_targets; DELETE FROM stock_movements; DELETE FROM inventory_balances; DELETE FROM inventory_vendor_items; DELETE FROM inventory_vendors; DELETE FROM inventory_items; DELETE FROM inventory_locations; DELETE FROM ingredients; DELETE FROM users;");
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, password_hash, full_name, role, employee_id, created_at, updated_at)
     VALUES (501, ?, ?, 'Inventory Manager', 'MANAGER', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind("inventory.manager@example.com", HASH).run();
  await testEnv.DB.prepare(
    `INSERT INTO inventory_locations (id, name, description, active, created_at, updated_at)
     VALUES (10, 'Walk-In', 'Primary cooler', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run();
});

describe("Worker inventory domain", () => {
  it("creates and lists items, vendors, balances, and stock", async () => {
    const itemResponse = await request("/inventory/items", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: "Synthetic Milk",
        category: "Dairy",
        base_unit: "gallon",
        default_location_id: 10,
        cost_cents: 425,
      }),
    });
    expect(itemResponse.status).toBe(201);
    const item = await itemResponse.json<{ id: number; active: boolean }>();
    expect(item.active).toBe(true);

    const balance = await request(`/inventory/items/${item.id}/balances`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ location_id: 10, minimum_quantity: 2, par_quantity: 8 }),
    });
    expect(balance.status).toBe(200);

    const vendor = await request("/inventory/vendors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Synthetic Foods", lead_time_days: 2 }),
    });
    expect(vendor.status).toBe(201);
    await expect(request("/inventory/items?active=true").then((response) => response.json()))
      .resolves.toEqual([expect.objectContaining({ id: item.id, name: "Synthetic Milk" })]);
    await expect(request("/inventory/stock").then((response) => response.json()))
      .resolves.toEqual([expect.objectContaining({ inventory_item_id: item.id, status: "OUT" })]);
  });

  it("posts an idempotent movement and returns dashboard totals", async () => {
    await testEnv.DB.prepare(
      `INSERT INTO inventory_items
       (id, ingredient_id, name, category, sku, base_unit, purchase_unit,
        purchase_to_base, default_location_id, cost_cents, shelf_life_days,
        active, created_at, updated_at)
       VALUES (20, NULL, 'Synthetic Chicken', 'Protein', NULL, 'case', NULL,
        1, 10, 1000, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    const payload = {
      inventory_item_id: 20,
      location_id: 10,
      quantity_change: 3,
      reason: "RECEIVING",
      source_event_key: "test-receiving-20",
    };
    const first = await request("/inventory/movements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(201);
    const second = await request("/inventory/movements", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    expect(second.status).toBe(201);
    const count = await testEnv.DB.prepare("SELECT COUNT(*) AS total FROM stock_movements")
      .first<{ total: number }>();
    expect(count?.total).toBe(1);

    const dashboard = await request("/inventory/dashboard");
    expect(dashboard.status).toBe(200);
    await expect(dashboard.json()).resolves.toMatchObject({
      item_count: 1,
      location_count: 1,
      total_inventory_value_cents: 3000,
    });
  });

  it("runs planning, draft ordering, receiving, and count-sheet workflows", async () => {
    const item = await request("/inventory/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Synthetic Lettuce", category: "Produce", base_unit: "each", purchase_unit: "case", purchase_to_base: 1, default_location_id: 10, cost_cents: 0 }) }).then(response => response.json<{ id: number }>());
    const vendor = await request("/inventory/vendors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Synthetic Produce Vendor", lead_time_days: 1 }) }).then(response => response.json<{ id: number }>());
    const settings = await request("/inventory/settings/targets", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_id: 10, rows: [{ inventory_item_id: item.id, planning_active: true, weekday_targets: { "0": 8 }, preferred_vendor_id: vendor.id, purchase_unit: "case", pack_quantity: 4, unit_price_cents: 1200 }] }) });
    expect(settings.status).toBe(200);
    const configuredItem = await testEnv.DB.prepare("SELECT purchase_to_base, cost_cents FROM inventory_items WHERE id=?").bind(item.id).first<{ purchase_to_base: number; cost_cents: number }>();
    expect(configuredItem).toMatchObject({ purchase_to_base: 4, cost_cents: 300 });
    const planner = await request("/inventory/purchase-order-planner?location_id=10&delivery_date=2026-08-03");
    await expect(planner.json()).resolves.toMatchObject({ rows: [expect.objectContaining({ inventory_item_id: item.id, target_quantity: 8, recommended_purchase_quantity: 2 })] });

    const planned = await request("/inventory/purchase-orders/from-plan", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expected_date: "2026-08-03", lines: [{ inventory_item_id: item.id, location_id: 10, purchase_quantity: 8 }] }) });
    expect(planned.status).toBe(201);
    const orders = await planned.json<Array<{ id: number; lines: Array<{ id: number }> }>>();
    await request(`/inventory/purchase-orders/${orders[0].id}/submit`, { method: "POST", body: "{}" });
    const received = await request("/inventory/receiving", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ purchase_order_id: orders[0].id, lines: [{ purchase_order_line_id: orders[0].lines[0].id, inventory_item_id: item.id, location_id: 10, received_quantity: 8, unit_price_cents: 1200 }] }) });
    expect(received.status).toBe(201);
    await expect(received.json()).resolves.toMatchObject({ status: "RECEIVED" });

    const sheetResponse = await request("/inventory/count-sheets", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ location_id: 10, resume_existing: false }) });
    expect(sheetResponse.status).toBe(201);
    const sheet = await sheetResponse.json<{ id: number; lines: Array<{ id: number }> }>();
    const xlsx = await request(`/inventory/count-sheets/${sheet.id}/export.xlsx`);
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers.get("content-type")).toContain("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const workbookFiles = unzipSync(new Uint8Array(await xlsx.arrayBuffer()));
    expect(strFromU8(workbookFiles["xl/worksheets/sheet1.xml"])).toContain('<autoFilter ref="A2:K3"/>');
    const edited = await request(`/inventory/count-sheets/${sheet.id}/lines/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ edits: [{ line_id: sheet.lines[0].id, counted_quantity: 7, is_counted: true, review_status: "READY" }] }) });
    expect(edited.status).toBe(200);
    expect((await request(`/inventory/count-sheets/${sheet.id}/approve`, { method: "POST", body: "{}" })).status).toBe(200);
    expect((await request(`/inventory/counts/${sheet.id}/post`, { method: "POST", body: "{}" })).status).toBe(200);
    const balance = await testEnv.DB.prepare("SELECT quantity_on_hand FROM inventory_balances WHERE inventory_item_id=? AND location_id=10").bind(item.id).first<{ quantity_on_hand: number }>();
    expect(balance?.quantity_on_hand).toBe(7);
  });

  it("previews and imports a purchase-order CSV idempotently", async () => {
    const item = await request("/inventory/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Synthetic Yogurt", category: "Dairy", sku: "SYN-1", base_unit: "case", default_location_id: 10 }) }).then(response => response.json<{ id: number }>());
    const vendor = await request("/inventory/vendors", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Synthetic Dairy Vendor" }) }).then(response => response.json<{ id: number }>());
    const csv = "Item,SKU,Qty,Unit Price\r\nSynthetic Yogurt,SYN-1,3,12.50\r\n";
    const payload = { vendor_id: vendor.id, default_location_id: 10, expected_date: "2026-08-10", source_filename: "synthetic.csv", csv_text: csv };
    const preview = await request("/inventory/purchase-orders/import-preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    await expect(preview.json()).resolves.toMatchObject({ ready_to_import: true, matched_count: 1, rows: [expect.objectContaining({ inventory_item_id: item.id, unit_price_cents: 1250 })] });
    expect((await request("/inventory/purchase-orders/import-csv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).status).toBe(201);
    expect((await request("/inventory/purchase-orders/import-csv", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) })).status).toBe(409);
  });

  it("moves stock between locations atomically and records both transfer legs", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(`INSERT INTO inventory_locations (id, name, active, created_at, updated_at)
        VALUES (11, 'Dry Storage', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`),
      testEnv.DB.prepare(`INSERT INTO inventory_items
       (id, name, category, base_unit, purchase_to_base, default_location_id,
        cost_cents, active, created_at, updated_at)
        VALUES (30, 'Synthetic Flour', 'Dry Goods', 'bag', 1, 10, 500, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`),
      testEnv.DB.prepare(`INSERT INTO inventory_balances
       (inventory_item_id, location_id, quantity_on_hand, minimum_quantity,
        par_quantity, planning_active, created_at, updated_at)
        VALUES (30, 10, 9, 0, 0, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`),
    ]);
    const response = await request("/inventory/transfers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ inventory_item_id: 30, from_location_id: 10, to_location_id: 11, quantity: 4 }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toEqual([
      expect.objectContaining({ location_id: 10, quantity_change: -4, reason: "TRANSFER_OUT" }),
      expect.objectContaining({ location_id: 11, quantity_change: 4, reason: "TRANSFER_IN" }),
    ]);
    const balances = await testEnv.DB.prepare(
      "SELECT location_id, quantity_on_hand FROM inventory_balances WHERE inventory_item_id=30 ORDER BY location_id",
    ).all();
    expect(balances.results).toEqual([
      expect.objectContaining({ location_id: 10, quantity_on_hand: 5 }),
      expect.objectContaining({ location_id: 11, quantity_on_hand: 4 }),
    ]);
  });
});
