import { exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import { rewriteLegacyStaticPath } from "./index";

describe("TeamSheet Worker API foundation", () => {
  it("returns the FastAPI-compatible health payload", async () => {
    const response = await exports.default.fetch("https://example.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "application/json; charset=utf-8",
    );
    await expect(response.json()).resolves.toEqual({
      status: "ok",
      app: "Team Sheet Studio API",
    });
  });

  it("returns version and runtime metadata", async () => {
    const response = await exports.default.fetch("https://example.test/api/version");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      app: "Team Sheet Studio API",
      version: "0.1.0",
      environment: "local",
      runtime: "cloudflare-workers",
    });
  });

  it("rejects unsupported methods without invoking storage", async () => {
    const response = await exports.default.fetch("https://example.test/health", {
      method: "POST",
    });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
    await expect(response.json()).resolves.toEqual({
      detail: "Method Not Allowed",
    });
  });

  it("rewrites only the legacy static URL prefix", () => {
    expect(rewriteLegacyStaticPath("/static/index.html")).toBe("/index.html");
    expect(rewriteLegacyStaticPath("/static/")).toBe("/index.html");
    expect(rewriteLegacyStaticPath("/inventory.html")).toBeNull();
  });
});
