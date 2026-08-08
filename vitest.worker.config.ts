import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

const testSecret = randomBytes(32).toString("hex");
process.env.SECRET_KEY = testSecret;

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {
        configPath: "./wrangler.jsonc",
      },
      miniflare: {
        bindings: {
          SECRET_KEY: testSecret,
          TEST_MIGRATIONS: await readD1Migrations(
            resolve(process.cwd(), "d1", "migrations"),
          ),
        },
      },
    })),
  ],
  test: {
    include: ["worker/**/*.unit.test.ts"],
  },
});
