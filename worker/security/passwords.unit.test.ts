import { describe, expect, it } from "vitest";

import { verifyPassword } from "./passwords";

const FIXTURE_INPUT = "worker-compatibility-fixture";
const PASSLIB_HASHES = [
  "$pbkdf2-sha256$29000$d29ya2Vycy1maXh0dXJl$kNa9.hCgWiPN51HMmO7.KyQkbSrFwJw7OD.WoWdT6Kc",
  "$2b$04$abcdefghijklmnopqrstuu.bg.W5PcZcS/ck.QoBoBEEDqekSC4WG",
  "$2b$12$abcdefghijklmnopqrstuuVyrcjZpsXPNoG2aCRz7n9etE1uG9qZa",
  "$bcrypt-sha256$v=2,t=2b,r=4$abcdefghijklmnopqrstuu$cZbWQ7ryE5emagrYSx/e0FRJSKIBNOO",
  "$bcrypt-sha256$2b,4$abcdefghijklmnopqrstuu$5kPkq5f2rvpBULhsvNnWBMdhIe.X576",
] as const;

describe("Passlib password-hash compatibility", () => {
  it.each(PASSLIB_HASHES)("verifies a synthetic Passlib vector", async (hash) => {
    await expect(verifyPassword(FIXTURE_INPUT, hash)).resolves.toBe(true);
    await expect(verifyPassword(`${FIXTURE_INPUT}-incorrect`, hash)).resolves.toBe(false);
  });

  it("fails closed for malformed and unsupported hashes", async () => {
    await expect(verifyPassword(FIXTURE_INPUT, "not-a-supported-hash")).resolves.toBe(false);
    await expect(
      verifyPassword(FIXTURE_INPUT, "$pbkdf2-sha256$bad$bad$bad"),
    ).resolves.toBe(false);
  });
});
