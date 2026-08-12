import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type TestEnv = Env & { DB: D1Database };

const SECRET = "pos-integration-secret-that-is-long-enough";
const PASSWORD = "worker-compatibility-fixture";
const PASSWORD_HASH = "$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc";
const server = createTestHarness({
  workers: [{ configPath: "./wrangler.jsonc", secrets: { SECRET_KEY: SECRET } }],
});

function cookieValue(response: { headers: { get(name: string): string | null } }, name: string): string {
  const value = response.headers.get("set-cookie") ?? "";
  const match = new RegExp(`${name}=([^;,]+)`, "u").exec(value);
  if (match === null) throw new Error(`Missing ${name} cookie`);
  return `${name}=${match[1]}`;
}

async function appLogin(): Promise<string> {
  const response = await server.fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "pos.manager@example.com", password: PASSWORD }),
  });
  expect(response.status).toBe(200);
  return cookieValue(response, "tss_access_token");
}

beforeAll(async () => {
  await server.listen();
});

beforeEach(async () => {
  const worker = server.getWorker<TestEnv>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const tables = [
    "pos_order_items", "pos_payments", "pos_table_events", "pos_orders", "pos_tables", "pos_terminal_sessions",
    "pos_button_tags", "pos_button_modifier_groups", "pos_button_prompts", "pos_tag_modifier_groups", "pos_tag_prompts",
    "pos_config_audit", "pos_credentials", "pos_modifiers", "pos_prompts", "pos_modifier_groups", "pos_tags",
    "recipe_items", "pos_buttons", "pos_pages", "menu_items", "menu_categories", "employees", "users",
  ];
  for (const table of tables) await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO employees
       (id,first_name,last_name,nickname,role,employment_start_date,active,upsell_score,pitty_score,employment_days,max_section_load,notes,created_at,updated_at)
       VALUES(101,'Pat','Manager','Pat','MANAGER','2025-01-01',1,0,0,1,5,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ),
    env.DB.prepare(
      `INSERT INTO employees
       (id,first_name,last_name,nickname,role,employment_start_date,active,upsell_score,pitty_score,employment_days,max_section_load,notes,created_at,updated_at)
       VALUES(102,'Sam','Server','Sam','SERVER','2025-01-01',1,0,0,1,5,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ),
    env.DB.prepare(
      `INSERT INTO users(id,email,password_hash,full_name,role,employee_id,created_at,updated_at)
       VALUES(201,'pos.manager@example.com',?,'POS Manager','MANAGER',101,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(PASSWORD_HASH),
    env.DB.prepare("INSERT INTO menu_categories(id,name,description,active,display_order) VALUES(301,'Entrees',NULL,1,1)"),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("Cloudflare POS management and terminal", () => {
  it("manages a resolved button and rings it into a table check", async () => {
    const authCookie = await appLogin();
    const headers = { "Content-Type": "application/json", Cookie: authCookie };

    const page = await server.fetch("/pos/admin/config/pages", {
      method: "POST", headers,
      body: JSON.stringify({ slug: "dinner", name: "Dinner", active: true, display_order: 1, metadata: {} }),
    });
    expect(page.status).toBe(201);
    const pageBody = await page.json() as { id: number };

    const group = await server.fetch("/pos/admin/config/modifier-groups", {
      method: "POST", headers,
      body: JSON.stringify({
        slug: "temperature", name: "Temperature", prompt: "Choose temperature", required: true,
        minimum_selections: 1, maximum_selections: 1, allow_quantities: false, active: true,
        conditional_visibility: {}, metadata: {},
        modifiers: [{ internal_key: "medium", name: "Medium", price_delta_cents: 150, active: true, display_order: 1 }],
      }),
    });
    expect(group.status).toBe(201);
    const groupBody = await group.json() as { id: number; modifiers: Array<{ id: number }> };

    const button = await server.fetch("/pos/admin/config/buttons", {
      method: "POST", headers,
      body: JSON.stringify({
        internal_key: "test-steak", name: "Test Steak", display_name: "Test Steak", category_id: 301,
        page_id: pageBody.id, price_cents: 2400, button_type: "PRODUCT", active: true,
        availability: {}, visual: { background_color: "#dedede" }, routing: {}, metadata: {},
        grid_row: 1, grid_column: 1, grid_width: 1, grid_height: 1, display_order: 1,
        tag_ids: [], modifier_groups: [{ id: groupBody.id, display_order: 0, disabled: false, overrides: {} }],
        prompts: [], ingredients: [],
      }),
    });
    expect(button.status).toBe(201);
    const buttonBody = await button.json() as { id: number; modifier_groups: unknown[]; revision: number };
    expect(buttonBody.modifier_groups).toHaveLength(1);

    const staleLayout = await server.fetch("/pos/admin/config/layout", {
      method: "PUT", headers,
      body: JSON.stringify({ entries: [{ button_id: buttonBody.id, page_id: pageBody.id, grid_row: 2, grid_column: 1, grid_width: 1, grid_height: 1, display_order: 2, revision: buttonBody.revision + 1 }] }),
    });
    expect(staleLayout.status).toBe(409);

    const access = await server.fetch("/pos/admin/access/101", {
      method: "PUT", headers,
      body: JSON.stringify({ employee_number: "2468", access_role: "MANAGER", active: true }),
    });
    expect(access.status).toBe(200);

    const pin = await server.fetch("/pos/pin/login", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ employee_number: "2468" }),
    });
    expect(pin.status).toBe(200);
    const posCookie = cookieValue(pin, "tss_pos_session");
    const terminalHeaders = { "Content-Type": "application/json", Cookie: posCookie };

    const bootstrap = await server.fetch("/pos/terminal/bootstrap", { headers: { Cookie: posCookie } });
    expect(bootstrap.status).toBe(200);
    await expect(bootstrap.json()).resolves.toMatchObject({ features: { menu_items: true }, menu_config: { schema_version: 1 } });

    const table = await server.fetch("/pos/terminal/tables", {
      method: "POST", headers: terminalHeaders,
      body: JSON.stringify({ table_number: 42, client_request_id: "pos-integration-table-42" }),
    });
    expect(table.status).toBe(201);
    const tableBody = await table.json() as { revision: number; check: { id: number } };

    const item = await server.fetch(`/pos/terminal/checks/${tableBody.check.id}/items`, {
      method: "POST", headers: terminalHeaders,
      body: JSON.stringify({ button_id: buttonBody.id, quantity: 2, modifiers: [{ modifier_id: groupBody.modifiers[0].id, quantity: 1 }] }),
    });
    expect(item.status).toBe(201);
    await expect(item.json()).resolves.toMatchObject({ quantity: 2, price_cents: 2400, modifier_total_cents: 150, check: { subtotal_cents: 5100 } });
  });
});
