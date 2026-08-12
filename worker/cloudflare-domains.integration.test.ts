import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type TestEnv = Env & { DB: D1Database };
const PASSWORD = "worker-compatibility-fixture";
const HASH = "$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc";
const server = createTestHarness({ workers: [{ configPath: "./wrangler.jsonc", secrets: { SECRET_KEY: "cross-domain-integration-secret-value" } }] });

async function login(email: string): Promise<string> {
  const response = await server.fetch("/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password: PASSWORD }) });
  expect(response.status).toBe(200); const body = await response.json() as { access_token: string }; return `Bearer ${body.access_token}`;
}

beforeAll(async () => { await server.listen(); });
beforeEach(async () => {
  await server.reset(); const worker = server.getWorker<TestEnv>(); await worker.applyD1Migrations("DB"); const env = await worker.getEnv();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO employees(id,first_name,last_name,nickname,role,employment_start_date,active,created_at,updated_at) VALUES(101,'Morgan','Manager','Morgan','OTHER','2025-01-01',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"),
    env.DB.prepare("INSERT INTO employees(id,first_name,last_name,nickname,role,employment_start_date,active,created_at,updated_at) VALUES(102,'Taylor','Server','Taylor','SERVER','2025-01-01',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"),
    env.DB.prepare("INSERT INTO users(id,email,password_hash,full_name,role,employee_id,created_at,updated_at) VALUES(201,'domains.manager@example.com',?,'Morgan Manager','MANAGER',101,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(HASH),
    env.DB.prepare("INSERT INTO users(id,email,password_hash,full_name,role,employee_id,created_at,updated_at) VALUES(202,'domains.server@example.com',?,'Taylor Server','SERVER',102,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(HASH),
    env.DB.prepare("INSERT INTO sections(id,name,label,type,is_active) VALUES(301,'patio','Patio','PATIO',1)"),
    env.DB.prepare("INSERT INTO shifts(id,date,time_period,store_id,created_by_user_id,created_at,updated_at) VALUES(401,'2026-08-20','DINNER',1,201,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)"),
  ]);
});
afterAll(async () => { await server.close(); });

describe("Cloudflare migrated business domains", () => {
  it("runs team sheets, accounting, PYOS, and CSV imports on D1", async () => {
    const manager = await login("domains.manager@example.com"), jsonHeaders = { Authorization: manager, "Content-Type": "application/json" };
    const sheet = await server.fetch("/team-sheets", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ shift_id: 401, title: "Dinner floor", status: "PUBLISHED", assignments: [{ employee_id: 102, section_id: 301, role_label: "Server", order_index: 1 }], sidework: [{ label: "Polish", employee_ids: [102] }], outwork: [] }) });
    expect(sheet.status).toBe(201); const sheetBody = await sheet.json() as { id: number; assignments: unknown[]; sidework: unknown[] }; expect(sheetBody.assignments).toHaveLength(1); expect(sheetBody.sidework).toHaveLength(1);
    const clone = await server.fetch("/team-sheets", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ shift_id: 401, title: "Ignored clone title", source_team_sheet_id: sheetBody.id }) }); expect(clone.status).toBe(201); await expect(clone.json()).resolves.toMatchObject({ title: "Dinner floor (copy)", assignments: [{ employee_id: 102 }], sidework: [{ label: "Polish" }] });
    const csv = await server.fetch(`/team-sheets/${sheetBody.id}/export/csv`, { headers: { Authorization: manager } }); expect(csv.status).toBe(200); await expect(csv.text()).resolves.toContain("Taylor Server");

    const gifts = await server.fetch("/gift-tracker", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ week_number: 1, season_year: 2026, entries: [{ employee_name: "Taylor Server", tuesday: 100 }] }) }); expect(gifts.status).toBe(201);
    const tier = await server.fetch("/payouts/tiers", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ label: "Starter", season_year: 2026, min_amount_cents: 0, max_amount_cents: 20000, payout_type: "FIXED", payout_value: 500, active: true }) }); expect(tier.status).toBe(201);
    const summary = await server.fetch("/payouts/summary?season_year=2026", { headers: { Authorization: manager } }); expect(summary.status).toBe(200); await expect(summary.json()).resolves.toMatchObject({ rows: [{ employee_name: "Taylor Server", sales_total_cents: 10000, tier_payout_cents: 500 }] });

    const manual = await server.fetch("/pyos/requests/manual", { method: "POST", headers: jsonHeaders, body: JSON.stringify({ employee_id: 102, section_id: 301, date: "2026-08-21", shift: "PM", notes: "Manager assignment" }) }); expect(manual.status).toBe(201); await expect(manual.json()).resolves.toMatchObject({ status: "APPROVED", employee_name: "Taylor Server", section_label: "Patio" });

    const boundary = "----teamsheet-test-boundary", multipart = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="servers.csv"\r\nContent-Type: text/csv\r\n\r\nname,BLAST %,max_guests\nJamie New,108%,14\n\r\n--${boundary}--\r\n`;
    const imported = await server.fetch("/imports/servers", { method: "POST", headers: { Authorization: manager, "Content-Type": `multipart/form-data; boundary=${boundary}` }, body: multipart }); expect(imported.status).toBe(201); await expect(imported.json()).resolves.toEqual({ created: 1, updated: 0 });
    const importedRoster = await server.fetch("/employees?role=SERVER&active=true", { headers: { Authorization: manager } }); expect(importedRoster.status).toBe(200); await expect(importedRoster.json()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ first_name: "Jamie", last_name: "New", upsell_score: 108, max_section_load: 14 })]));
  });
});
