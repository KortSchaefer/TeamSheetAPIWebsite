import { randomBytes } from "node:crypto";

import { createTestHarness } from "wrangler";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

type TestEnv = Env & { DB: D1Database; VOICE_AUDIO: R2Bucket };

const FIXTURE_INPUT = "worker-compatibility-fixture";
const FIXTURE_HASH =
  "$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc";
const server = createTestHarness({
  workers: [{
    configPath: "./wrangler.jsonc",
    secrets: { SECRET_KEY: randomBytes(32).toString("hex") },
  }],
});

async function login(email: string): Promise<string> {
  const response = await server.fetch("/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: FIXTURE_INPUT }),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" || body === null ||
    !("access_token" in body) || typeof body.access_token !== "string"
  ) throw new Error("Login response did not contain an access token");
  return body.access_token;
}

async function uploadTarget(sessionId: number, token: string): Promise<{
  object_key: string;
  upload_url: string;
}> {
  const response = await server.fetch(
    `/inventory/voice/sessions/${sessionId}/audio-upload`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content_type: "audio/webm", filename: "chunk.webm" }),
    },
  );
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  if (
    typeof body !== "object" || body === null ||
    !("object_key" in body) || typeof body.object_key !== "string" ||
    !("upload_url" in body) || typeof body.upload_url !== "string"
  ) throw new Error("Upload target response was invalid");
  return { object_key: body.object_key, upload_url: body.upload_url };
}

async function putTarget(target: { upload_url: string }, body: Uint8Array) {
  return server.fetch(target.upload_url, {
    method: "PUT",
    headers: { "Content-Type": "audio/webm" },
    body,
  });
}

beforeAll(async () => {
  await server.listen();
});

beforeEach(async () => {
  const worker = server.getWorker<TestEnv>();
  await worker.applyD1Migrations("DB");
  const env = await worker.getEnv();
  const listed = await env.VOICE_AUDIO.list({ prefix: "voice/local/" });
  if (listed.objects.length > 0) {
    await env.VOICE_AUDIO.delete(listed.objects.map((object) => object.key));
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM inventory_voice_audio_objects"),
    env.DB.prepare("DELETE FROM inventory_voice_utterances"),
    env.DB.prepare("DELETE FROM inventory_voice_sessions"),
    env.DB.prepare("DELETE FROM inventory_locations"),
    env.DB.prepare("DELETE FROM users"),
  ]);
  for (const [id, email, role] of [
    [101, "owner.voice@example.com", "MANAGER"],
    [102, "other.voice@example.com", "MANAGER"],
    [103, "admin.voice@example.com", "ADMIN"],
    [104, "server.voice@example.com", "SERVER"],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO users
       (id, email, password_hash, full_name, role, employee_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NULL, '2026-08-04 12:00:00', '2026-08-04 12:00:00')`,
    ).bind(id, email, FIXTURE_HASH, `Synthetic ${role}`, role).run();
  }
  await env.DB.prepare(
    `INSERT INTO inventory_locations
     (id, name, description, active, created_at, updated_at)
     VALUES (201, 'Voice Test Cooler', NULL, 1, '2026-08-04', '2026-08-04')`,
  ).run();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO inventory_voice_sessions
       (id, client_session_id, manager_user_id, status, current_location_id,
        started_at, finished_at, last_client_sequence, device_metadata,
        transcription_model, normalization_model, prompt_version,
        audio_delete_after, error_message, created_at, updated_at)
       VALUES (301, '11111111-1111-4111-8111-111111111111', 101, 'LISTENING', 201,
        '2026-08-04 12:00:00', NULL, 0, NULL, 'gpt-realtime-whisper',
        'gpt-5.6-luna', 'voice-inventory-v1', '2099-08-05 12:00:00', NULL,
        '2026-08-04 12:00:00', '2026-08-04 12:00:00')`,
    ),
    env.DB.prepare(
      `INSERT INTO inventory_voice_sessions
       (id, client_session_id, manager_user_id, status, current_location_id,
        started_at, finished_at, last_client_sequence, device_metadata,
        transcription_model, normalization_model, prompt_version,
        audio_delete_after, error_message, created_at, updated_at)
       VALUES (302, '22222222-2222-4222-8222-222222222222', 102, 'FINISHED', 201,
        '2026-08-03 12:00:00', '2026-08-03 13:00:00', 0, NULL,
        'gpt-realtime-whisper', 'gpt-5.6-luna', 'voice-inventory-v1',
        '2026-08-04 12:00:00', NULL, '2026-08-03 12:00:00', '2026-08-03 13:00:00')`,
    ),
  ]);
});

afterAll(async () => {
  await server.close();
});

describe("private R2 voice-audio storage", () => {
  it("uploads, stores metadata, and streams only to authorized users", async () => {
    const [ownerToken, otherToken, adminToken, serverToken] = await Promise.all([
      login("owner.voice@example.com"),
      login("other.voice@example.com"),
      login("admin.voice@example.com"),
      login("server.voice@example.com"),
    ]);
    const target = await uploadTarget(301, ownerToken);
    expect(target.object_key).toMatch(
      /^voice\/local\/sessions\/301\/[0-9a-f-]{36}\.webm$/u,
    );
    const audio = new TextEncoder().encode("synthetic-audio-data");
    expect((await putTarget(target, audio)).status).toBe(204);

    const worker = server.getWorker<TestEnv>();
    const env = await worker.getEnv();
    await expect(
      env.DB.prepare(
        `SELECT object_key, content_type, byte_size, status
         FROM inventory_voice_audio_objects WHERE object_key = ?`,
      ).bind(target.object_key).first(),
    ).resolves.toEqual({
      object_key: target.object_key,
      content_type: "audio/webm",
      byte_size: audio.byteLength,
      status: "STORED",
    });

    const downloadPath = new URL(target.upload_url, "https://example.test").pathname;
    for (const token of [ownerToken, adminToken]) {
      const response = await server.fetch(downloadPath, {
        headers: { Authorization: `Bearer ${token}` },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-type")).toBe("audio/webm");
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(audio);
    }
    for (const [token, status] of [[otherToken, 403], [serverToken, 403]] as const) {
      expect((await server.fetch(downloadPath, {
        headers: { Authorization: `Bearer ${token}` },
      })).status).toBe(status);
    }
    expect((await server.fetch(downloadPath)).status).toBe(401);
  });

  it("rejects oversized chunks and marks a missing R2 object in D1", async () => {
    const ownerToken = await login("owner.voice@example.com");
    const oversized = await uploadTarget(301, ownerToken);
    expect((await putTarget(oversized, new Uint8Array(8 * 1024 * 1024 + 1))).status).toBe(413);

    const target = await uploadTarget(301, ownerToken);
    expect((await putTarget(target, new Uint8Array([1, 2, 3]))).status).toBe(204);
    const worker = server.getWorker<TestEnv>();
    const env = await worker.getEnv();
    await env.VOICE_AUDIO.delete(target.object_key);
    const downloadPath = new URL(target.upload_url, "https://example.test").pathname;
    const missing = await server.fetch(downloadPath, {
      headers: { Authorization: `Bearer ${ownerToken}` },
    });
    expect(missing.status).toBe(404);
    expect(
      await env.DB.prepare(
        "SELECT status FROM inventory_voice_audio_objects WHERE object_key = ?",
      ).bind(target.object_key).first("status"),
    ).toBe("MISSING");
  });

  it("cleans expired objects from R2 and D1 through the scheduled handler", async () => {
    const otherToken = await login("other.voice@example.com");
    const target = await uploadTarget(302, otherToken);
    expect((await putTarget(target, new Uint8Array([4, 5, 6]))).status).toBe(204);
    const worker = server.getWorker<TestEnv>();
    const env = await worker.getEnv();
    expect(await env.VOICE_AUDIO.head(target.object_key)).not.toBeNull();

    const outcome = await worker.scheduled({
      cron: "17 * * * *",
      scheduledTime: new Date("2026-08-05T12:00:00Z"),
    });
    expect(outcome.outcome).toBe("ok");
    expect(await env.VOICE_AUDIO.head(target.object_key)).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT status FROM inventory_voice_audio_objects WHERE object_key = ?",
      ).bind(target.object_key).first("status"),
    ).toBe("DELETED");
    expect(
      await env.DB.prepare(
        "SELECT audio_delete_after FROM inventory_voice_sessions WHERE id = 302",
      ).first("audio_delete_after"),
    ).toBeNull();
  });
});
