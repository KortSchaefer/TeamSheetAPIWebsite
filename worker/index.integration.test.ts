import { randomBytes } from "node:crypto";
import { createTestHarness } from "wrangler";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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

afterEach(async () => {
  await server.reset();
});

afterAll(async () => {
  await server.close();
});

describe("TeamSheet Worker with Static Assets", () => {
  it("serves the health and version endpoints", async () => {
    const health = await server.fetch("/health");
    const version = await server.fetch("/api/version");

    expect(health.status).toBe(200);
    await expect(health.json()).resolves.toEqual({
      status: "ok",
      app: "Team Sheet Studio API",
    });
    expect(version.status).toBe(200);
    await expect(version.json()).resolves.toMatchObject({
      version: "0.1.0",
      environment: "local",
      runtime: "cloudflare-workers",
    });
  });

  it("serves the existing public homepage", async () => {
    const response = await server.fetch("/");
    const html = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(html).toContain("<title>Team Sheet Studio - Manager Console</title>");
  });

  it("preserves FastAPI's legacy static asset URLs", async () => {
    const response = await server.fetch("/static/team-sheet-studio.css");
    const css = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/css");
    expect(css).toContain(".studio-shell");
  });
});
