import { describe, expect, it } from "vitest";

import { createToken, verifyToken } from "./jwt";

describe("HS256 application tokens", () => {
  it("round-trips a valid user subject", async () => {
    const secret = crypto.randomUUID();
    const token = await createToken(42, secret, 5);

    await expect(verifyToken(token, secret)).resolves.toBe(42);
    await expect(verifyToken(token, crypto.randomUUID())).resolves.toBeNull();
  });

  it("rejects expired and malformed tokens", async () => {
    const secret = crypto.randomUUID();
    const expired = await createToken(42, secret, -1);

    await expect(verifyToken(expired, secret)).resolves.toBeNull();
    await expect(verifyToken("not-a-token", secret)).resolves.toBeNull();
  });
});
