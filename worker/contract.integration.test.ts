import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type ContractFixture = {
  id: string;
  request: {
    method: string;
    path: string;
    auth: string;
    json?: unknown;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
};

function fixture(name: string): ContractFixture {
  return JSON.parse(
    readFileSync(
      resolve(process.cwd(), "contracts", "fastapi", "fixtures", `${name}.json`),
      "utf8",
    ),
  ) as ContractFixture;
}

const healthFixture = fixture("health_success");
const invalidLoginFixture = fixture("invalid_login_error");
const authenticationRequiredFixture = fixture("authentication_required_error");
const currentUserFixture = fixture("auth_me_success");
const inventoryLocationsFixture = fixture("inventory_locations_success");
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
  await server.reset();
  const worker = server.getWorker<Env & { DB: D1Database }>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users
       (id, email, password_hash, full_name, role, employee_id, created_at, updated_at)
       VALUES (1001, 'manager.contract@example.com', ?, 'Contract Manager',
               'MANAGER', NULL, '<datetime>', '<datetime>')`,
    ).bind(FIXTURE_HASH),
    env.DB.prepare(
      `INSERT INTO inventory_locations
       (id, name, description, active, created_at, updated_at)
       VALUES (1, 'Contract Walk-In', 'Fixture location', 1,
               '<datetime>', '<datetime>')`,
    ),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("FastAPI compatibility fixtures", () => {
  it("matches the shared FastAPI health response fixture", async () => {
    const response = await server.fetch(healthFixture.request.path, {
      method: healthFixture.request.method,
    });
    const contentType = response.headers.get("content-type")?.split(";", 1)[0];

    expect(response.status).toBe(healthFixture.response.status);
    expect(contentType).toBe(healthFixture.response.headers["content-type"]);
    await expect(response.json()).resolves.toEqual(healthFixture.response.body);
  });

  it.each([invalidLoginFixture, authenticationRequiredFixture])(
    "matches the $id fixture",
    async (contract) => {
      const response = await server.fetch(contract.request.path, {
        method: contract.request.method,
        headers: contract.request.json
          ? { "Content-Type": "application/json" }
          : undefined,
        body: contract.request.json ? JSON.stringify(contract.request.json) : undefined,
      });

      expect(response.status).toBe(contract.response.status);
      for (const [name, value] of Object.entries(contract.response.headers)) {
        expect(response.headers.get(name)?.split(";", 1)[0]).toBe(value);
      }
      await expect(response.json()).resolves.toEqual(contract.response.body);
    },
  );

  it.each([currentUserFixture, inventoryLocationsFixture])(
    "matches the $id fixture",
    async (contract) => {
      const login = await server.fetch("/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "manager.contract@example.com",
          password: FIXTURE_INPUT,
        }),
      });
      const token: unknown = await login.json();
      if (
        typeof token !== "object" ||
        token === null ||
        !("access_token" in token) ||
        typeof token.access_token !== "string"
      ) {
        throw new Error("Login response did not contain an access token");
      }
      const response = await server.fetch(contract.request.path, {
        method: contract.request.method,
        headers: { Authorization: `Bearer ${token.access_token}` },
      });

      expect(response.status).toBe(contract.response.status);
      expect(response.headers.get("content-type")?.split(";", 1)[0]).toBe(
        contract.response.headers["content-type"],
      );
      await expect(response.json()).resolves.toEqual(contract.response.body);
    },
  );
});
