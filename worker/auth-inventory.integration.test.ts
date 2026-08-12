import { randomBytes } from "node:crypto";

import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type TestEnv = Env & { DB: D1Database };

const FIXTURE_INPUT = "worker-compatibility-fixture";
const FIXTURE_HASH =
  "$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc";
const server = createTestHarness({
  workers: [
    {
      configPath: "./wrangler.jsonc",
      secrets: { SECRET_KEY: randomBytes(32).toString("hex") },
    },
  ],
});

beforeAll(async () => {
  await server.listen();
});

beforeEach(async () => {
  const worker = server.getWorker<TestEnv>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM inventory_locations"),
    env.DB.prepare("DELETE FROM users"),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
       (id, email, password_hash, full_name, role, employee_id, created_at, updated_at)
       VALUES (7, ?, ?, 'Integration Manager', 'MANAGER', NULL, ?, ?)`,
    ).bind(
      "manager.integration@example.com",
      FIXTURE_HASH,
      "2026-08-04 13:00:00",
      "2026-08-04 13:00:00",
    ),
    env.DB.prepare(
      `INSERT INTO inventory_locations
       (id, name, description, active, created_at, updated_at)
       VALUES (8, 'Integration Walk-In', 'Cold storage', 1, ?, ?)`,
    ).bind("2026-08-04", "2026-08-04"),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("Worker HTTP authentication and inventory integration", () => {
  it("registers and signs in a new user through HTTP and D1", async () => {
    const registration = await server.fetch("/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "new.integration@example.com",
        password: "integration-password",
        full_name: "New Integration User",
        role: "SERVER",
      }),
    });
    expect(registration.status).toBe(201);
    await expect(registration.json()).resolves.toMatchObject({
      email: "new.integration@example.com",
      role: "SERVER",
    });

    const login = await server.fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "new.integration@example.com",
        password: "integration-password",
      }),
    });
    expect(login.status).toBe(200);
  });

  it("logs in, resolves the user, and reads inventory through local D1", async () => {
    const login = await server.fetch("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "manager.integration@example.com",
        password: FIXTURE_INPUT,
      }),
    });
    const tokens: unknown = await login.json();
    expect(login.status).toBe(200);
    if (
      typeof tokens !== "object" ||
      tokens === null ||
      !("access_token" in tokens) ||
      typeof tokens.access_token !== "string"
    ) {
      throw new Error("Login response did not contain an access token");
    }

    const headers = { Authorization: `Bearer ${tokens.access_token}` };
    const currentUser = await server.fetch("/auth/me", { headers });
    expect(currentUser.status).toBe(200);
    await expect(currentUser.json()).resolves.toMatchObject({
      id: 7,
      email: "manager.integration@example.com",
      role: "MANAGER",
    });

    const locations = await server.fetch("/inventory/locations", { headers });
    expect(locations.status).toBe(200);
    await expect(locations.json()).resolves.toEqual([
      {
        id: 8,
        name: "Integration Walk-In",
        description: "Cold storage",
        active: true,
      },
    ]);
  });
});
