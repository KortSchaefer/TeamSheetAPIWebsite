import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

type D1TestEnv = Env & { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };
const testEnv = env as D1TestEnv;
const PASSWORD = "worker-compatibility-fixture";
const HASH = "$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc";

async function authRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const login = await exports.default.fetch("https://example.test/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "voice.manager@example.com", password: PASSWORD }),
  });
  const token = await login.json<{ access_token: string }>();
  return exports.default.fetch(`https://example.test${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token.access_token}`, "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await testEnv.DB.exec(`
    DELETE FROM inventory_voice_session_counts;
    DELETE FROM inventory_voice_entries;
    DELETE FROM inventory_voice_utterances;
    DELETE FROM inventory_voice_sessions;
    DELETE FROM inventory_count_lines;
    DELETE FROM inventory_counts;
    DELETE FROM inventory_items;
    DELETE FROM inventory_locations;
    DELETE FROM users;
  `);
  await testEnv.DB.prepare(
    `INSERT INTO users (id, email, password_hash, full_name, role, employee_id, created_at, updated_at)
     VALUES (601, ?, ?, 'Voice Manager', 'MANAGER', NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind("voice.manager@example.com", HASH).run();
  await testEnv.DB.prepare(
    `INSERT INTO inventory_locations (id, name, description, active, created_at, updated_at)
     VALUES (61, 'Synthetic Walk-In', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (62, 'Synthetic Bar', NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run();
  await testEnv.DB.prepare(
    `INSERT INTO inventory_items
     (id, ingredient_id, name, category, sku, base_unit, purchase_unit, purchase_to_base,
      default_location_id, cost_cents, shelf_life_days, active, created_at, updated_at)
     VALUES (611, NULL, 'Synthetic Milk', 'Dairy', NULL, 'case', NULL, 1, 61, 100, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
            (612, NULL, 'Synthetic Chicken', 'Protein', NULL, 'case', NULL, 1, 61, 200, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).run();
});

describe("Worker voice inventory", () => {
  it("creates, resumes, normalizes transition words, and finishes a session", async () => {
    await expect(authRequest("/inventory/voice/sessions/active").then((response) => response.json()))
      .resolves.toBeNull();
    const create = await authRequest("/inventory/voice/sessions", {
      method: "POST",
      body: JSON.stringify({ client_session_id: "synthetic-session-0001", initial_location_id: 61 }),
    });
    expect(create.status).toBe(201);
    const session = await create.json<{ id: number }>();

    const payload = {
      client_event_id: "synthetic-event-000001",
      sequence: 1,
      transcript: "Synthetic Milk 3 next Synthetic Chicken 2",
    };
    const utterance = await authRequest(`/inventory/voice/sessions/${session.id}/utterances`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(utterance.status).toBe(201);
    await expect(utterance.json()).resolves.toMatchObject({
      entries: expect.arrayContaining([
        expect.objectContaining({ inventory_item_id: 611, normalized_quantity: 3, review_status: "AUTO_ACCEPTED" }),
        expect.objectContaining({ inventory_item_id: 612, normalized_quantity: 2, review_status: "AUTO_ACCEPTED" }),
      ]),
    });
    const duplicate = await authRequest(`/inventory/voice/sessions/${session.id}/utterances`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    expect(duplicate.status).toBe(201);
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS total FROM inventory_voice_utterances").first<{ total: number }>())?.total).toBe(1);
    const switched = await authRequest(`/inventory/voice/sessions/${session.id}/utterances`, {
      method: "POST",
      body: JSON.stringify({ client_event_id: "synthetic-event-switch", sequence: 2, transcript: "switch to Synthetic Bar" }),
    });
    await expect(switched.json()).resolves.toMatchObject({
      normalized_payload: { command: "SWITCH_LOCATION", location_id: 62 },
      feedback: { speak: "Switched to Synthetic Bar." },
    });
    await expect(authRequest(`/inventory/voice/sessions/${session.id}`).then((response) => response.json()))
      .resolves.toMatchObject({ current_location_id: 62, current_location_name: "Synthetic Bar" });

    const finish = await authRequest(`/inventory/voice/sessions/${session.id}/finish`, { method: "POST", body: "{}" });
    expect(finish.status).toBe(200);
    await expect(finish.json()).resolves.toMatchObject({
      status: "FINISHED",
      effective_counts: expect.arrayContaining([
        expect.objectContaining({ inventory_item_id: 611, quantity: 3 }),
        expect.objectContaining({ inventory_item_id: 612, quantity: 2 }),
      ]),
      draft_counts: [expect.objectContaining({ location_id: 61 })],
    });
  });

  it("returns a controlled browser-fallback response when realtime is unavailable", async () => {
    const create = await authRequest("/inventory/voice/sessions", {
      method: "POST",
      body: JSON.stringify({ client_session_id: "synthetic-session-0002", initial_location_id: 61 }),
    });
    const session = await create.json<{ id: number }>();
    const realtime = await authRequest(`/inventory/voice/sessions/${session.id}/realtime-token`, { method: "POST", body: "{}" });
    expect(realtime.status).toBe(503);
    await expect(realtime.json()).resolves.toMatchObject({ detail: { code: "OPENAI_NOT_CONFIGURED" } });
  });

  it("writes finished voice counts into the count sheet that launched the session", async () => {
    await testEnv.DB.prepare(
      `INSERT INTO inventory_counts
       (id, location_id, status, counted_by_user_id, revision, created_at, updated_at)
       VALUES (620, 61, 'DRAFT', 601, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).run();
    await testEnv.DB.prepare(
      `INSERT INTO inventory_count_lines
       (id, count_id, inventory_item_id, counted_quantity, expected_quantity,
        display_order, is_counted, source, review_status, revision)
       VALUES (621, 620, 611, 0, 4, 0, 0, 'MANUAL', 'NOT_COUNTED', 1)`,
    ).run();
    const create = await authRequest("/inventory/voice/sessions", {
      method: "POST",
      body: JSON.stringify({
        client_session_id: "synthetic-session-linked",
        initial_location_id: 61,
        device_metadata: { target_count_id: 620 },
      }),
    });
    expect(create.status).toBe(201);
    const session = await create.json<{ id: number; draft_counts: Array<{ inventory_count_id: number }> }>();
    expect(session.draft_counts).toEqual([expect.objectContaining({ inventory_count_id: 620 })]);
    await authRequest(`/inventory/voice/sessions/${session.id}/utterances`, {
      method: "POST",
      body: JSON.stringify({
        client_event_id: "synthetic-event-linked",
        sequence: 1,
        transcript: "Synthetic Milk 9",
      }),
    });
    expect((await authRequest(`/inventory/voice/sessions/${session.id}/finish`, {
      method: "POST",
      body: "{}",
    })).status).toBe(200);
    await expect(testEnv.DB.prepare(
      "SELECT counted_quantity, is_counted, source FROM inventory_count_lines WHERE count_id = 620 AND inventory_item_id = 611",
    ).first()).resolves.toMatchObject({ counted_quantity: 9, is_counted: 1, source: "VOICE" });
    expect((await testEnv.DB.prepare("SELECT COUNT(*) AS total FROM inventory_counts").first<{ total: number }>())?.total).toBe(1);
    const reopen = await authRequest("/inventory/voice/sessions", {
      method: "POST",
      body: JSON.stringify({
        client_session_id: "synthetic-session-reopen",
        initial_location_id: 61,
        device_metadata: { target_count_id: 620 },
      }),
    });
    expect(reopen.status).toBe(201);
    await expect(reopen.json()).resolves.toMatchObject({ id: session.id, status: "FINISHED" });
  });

  it("resolves a clarification with an auditable replacement entry", async () => {
    const create = await authRequest("/inventory/voice/sessions", {
      method: "POST",
      body: JSON.stringify({ client_session_id: "synthetic-session-review", initial_location_id: 61 }),
    });
    const session = await create.json<{ id: number }>();
    const utteranceResponse = await authRequest(`/inventory/voice/sessions/${session.id}/utterances`, {
      method: "POST",
      body: JSON.stringify({ client_event_id: "synthetic-event-review", sequence: 1, transcript: "mystery product 5" }),
    });
    const utterance = await utteranceResponse.json<{ id: number; entries: Array<{ id: number }> }>();
    const corrected = await authRequest(`/inventory/voice/sessions/${session.id}/clarifications`, {
      method: "POST",
      body: JSON.stringify({ utterance_id: utterance.id, selected_inventory_item_id: 611, quantity: 5, unit: "case" }),
    });
    expect(corrected.status).toBe(200);
    await expect(corrected.json()).resolves.toMatchObject({
      inventory_item_id: 611,
      normalized_quantity: 5,
      review_status: "CORRECTED",
      supersedes_entry_id: utterance.entries[0].id,
    });
    await expect(testEnv.DB.prepare("SELECT review_status FROM inventory_voice_entries WHERE id=?")
      .bind(utterance.entries[0].id).first()).resolves.toMatchObject({ review_status: "REJECTED" });
  });
});
