import { env, exports } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

type D1TestEnv = Env & {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const testEnv = env as D1TestEnv;
const FIXTURE_INPUT = "worker-compatibility-fixture";
const FIXTURE_HASH =
  "$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc";

async function seed(): Promise<void> {
  await testEnv.DB.batch([
    testEnv.DB.prepare("DELETE FROM inventory_locations"),
    testEnv.DB.prepare("DELETE FROM users"),
  ]);
  await testEnv.DB.prepare(
    `INSERT INTO users
     (id, email, password_hash, full_name, role, employee_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
    .bind(
      42,
      "server.worker@example.com",
      FIXTURE_HASH,
      "Worker Server",
      "SERVER",
      "2026-08-04 12:00:00",
      "2026-08-04 12:00:00",
    )
    .run();
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO inventory_locations
       (id, name, description, active, created_at, updated_at)
       VALUES (1, 'Z Cooler', NULL, 1, '2026-08-04', '2026-08-04')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO inventory_locations
       (id, name, description, active, created_at, updated_at)
       VALUES (2, 'A Walk-In', 'Primary cooler', 1, '2026-08-04', '2026-08-04')`,
    ),
    testEnv.DB.prepare(
      `INSERT INTO inventory_locations
       (id, name, description, active, created_at, updated_at)
       VALUES (3, 'Inactive', NULL, 0, '2026-08-04', '2026-08-04')`,
    ),
  ]);
}

async function login(): Promise<{ token: string; cookies: string }> {
  const response = await exports.default.fetch("https://example.test/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: "server.worker@example.com",
      password: FIXTURE_INPUT,
    }),
  });
  const body = await response.json<{
    access_token: string;
    refresh_token: string;
    token_type: string;
  }>();
  return {
    token: body.access_token,
    cookies: `tss_access_token=${body.access_token}`,
  };
}

beforeEach(async () => {
  await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
  await seed();
});

describe("authentication and inventory vertical slice", () => {
  it("registers a user with a FastAPI-compatible password hash", async () => {
    const response = await exports.default.fetch("https://example.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "new.user@example.com",
        password: "new-user-password",
        full_name: "New User",
        role: "MANAGER",
      }),
    });
    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({
      email: "new.user@example.com",
      full_name: "New User",
      role: "MANAGER",
      employee_id: null,
    });
    expect(response.headers.get("set-cookie")).toContain("tss_access_token=");

    const loginResponse = await exports.default.fetch("https://example.test/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "new.user@example.com",
        password: "new-user-password",
      }),
    });
    expect(loginResponse.status).toBe(200);

    const stored = await testEnv.DB.prepare(
      "SELECT password_hash FROM users WHERE email = ?",
    ).bind("new.user@example.com").first<{ password_hash: string }>();
    expect(stored?.password_hash).toMatch(/^\$pbkdf2-sha256\$29000\$/u);
  });

  it("preserves registration validation and duplicate-email errors", async () => {
    const duplicate = await exports.default.fetch("https://example.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "server.worker@example.com",
        password: "valid-password",
        full_name: "Duplicate",
      }),
    });
    expect(duplicate.status).toBe(400);
    await expect(duplicate.json()).resolves.toEqual({ detail: "Email already registered" });

    const invalid = await exports.default.fetch("https://example.test/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "not-an-email", password: "short" }),
    });
    expect(invalid.status).toBe(422);
    await expect(invalid.json()).resolves.toMatchObject({ detail: expect.any(Array) });
  });

  it("logs in with Passlib credentials and sets compatible cookies", async () => {
    const response = await exports.default.fetch("https://example.test/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "server.worker@example.com",
        password: FIXTURE_INPUT,
      }),
    });
    const body = await response.json<{
      access_token: string;
      refresh_token: string;
      token_type: string;
    }>();

    expect(response.status).toBe(200);
    expect(body.token_type).toBe("bearer");
    expect(body.access_token).toBeTruthy();
    expect(body.refresh_token).toBeTruthy();
    const cookies = response.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("tss_access_token=");
    expect(cookies).toContain("tss_refresh_token=");
    expect(cookies).toContain(
      "HttpOnly; Max-Age=3600; Path=/; SameSite=lax; Secure",
    );
  });

  it("supports OAuth2 form login and rejects incorrect credentials", async () => {
    const form = new URLSearchParams({
      username: "server.worker@example.com",
      password: FIXTURE_INPUT,
    });
    const tokenResponse = await exports.default.fetch("https://example.test/auth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    expect(tokenResponse.status).toBe(200);

    const denied = await exports.default.fetch("https://example.test/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "server.worker@example.com",
        password: `${FIXTURE_INPUT}-incorrect`,
      }),
    });
    expect(denied.status).toBe(401);
    await expect(denied.json()).resolves.toEqual({
      detail: "Incorrect email or password",
    });
  });

  it("uses FastAPI's 422 validation envelope for an incomplete JSON login", async () => {
    const response = await exports.default.fetch("https://example.test/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toEqual({
      detail: [
        {
          type: "missing",
          loc: ["body", "email"],
          msg: "Field required",
          input: {},
        },
        {
          type: "missing",
          loc: ["body", "password"],
          msg: "Field required",
          input: {},
        },
      ],
    });
  });

  it("resolves the current user from bearer and cookie authentication", async () => {
    const { token, cookies } = await login();
    for (const headers of [
      new Headers({ Authorization: `Bearer ${token}` }),
      new Headers({ Cookie: cookies }),
    ]) {
      const response = await exports.default.fetch("https://example.test/auth/me", {
        headers,
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        created_at: "2026-08-04T12:00:00",
        updated_at: "2026-08-04T12:00:00",
        id: 42,
        email: "server.worker@example.com",
        full_name: "Worker Server",
        role: "SERVER",
        employee_id: null,
      });
    }
  });

  it("allows an authenticated server to list only active locations", async () => {
    const { token } = await login();
    const response = await exports.default.fetch(
      "https://example.test/inventory/locations",
      { headers: { Authorization: `Bearer ${token}` } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { id: 2, name: "A Walk-In", description: "Primary cooler", active: true },
      { id: 1, name: "Z Cooler", description: null, active: true },
    ]);
  });

  it("returns the FastAPI authentication error and supports logout", async () => {
    const denied = await exports.default.fetch(
      "https://example.test/inventory/locations",
    );
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
    await expect(denied.json()).resolves.toEqual({
      detail: "Could not validate credentials",
    });

    const logoutResponse = await exports.default.fetch(
      "https://example.test/auth/logout",
      { method: "POST" },
    );
    expect(logoutResponse.status).toBe(204);
    expect(await logoutResponse.text()).toBe("");
    const cookies = logoutResponse.headers.get("set-cookie") ?? "";
    expect(cookies).toContain("tss_access_token=");
    expect(cookies).toContain("tss_refresh_token=");
  });
});
