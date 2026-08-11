import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

import type { AGMServiceRoom } from "./index";

type AGMTestEnv = Env & {
  AGM_SERVICE: DurableObjectNamespace<AGMServiceRoom>;
};

describe("AGM Floor service coordination", () => {
  it("serializes revisions and replays completed idempotency keys", async () => {
    const room = (env as AGMTestEnv).AGM_SERVICE.getByName(`agm-test-${crypto.randomUUID()}`);
    await expect(room.syncRevision(4)).resolves.toBe(4);

    await expect(room.begin("command-0001", 3)).resolves.toMatchObject({ status: "CONFLICT", revision: 4 });
    await expect(room.begin("command-0001", 4)).resolves.toMatchObject({ status: "ACCEPTED", revision: 4 });
    await expect(room.begin("command-0002", 4)).resolves.toMatchObject({ status: "BUSY", revision: 4 });

    const result = { service_revision: 5, event: { type: "SEAT" } };
    await room.complete("command-0001", 5, result);
    await expect(room.begin("command-0001", 4)).resolves.toMatchObject({ status: "COMPLETED", revision: 5, result });
    await expect(room.begin("command-0002", 4)).resolves.toMatchObject({ status: "CONFLICT", revision: 5 });
    await expect(room.begin("command-0002", 5)).resolves.toMatchObject({ status: "ACCEPTED", revision: 5 });
    await room.abort("command-0002");
  });
});
