import { env } from "cloudflare:workers";
import { applyD1Migrations } from "cloudflare:test";
import type { D1Migration } from "cloudflare:test";
import { describe, expect, it } from "vitest";

type D1TestEnv = Env & {
  DB: D1Database;
  TEST_MIGRATIONS: D1Migration[];
};

const testEnv = env as D1TestEnv;

async function applicationTableNames(): Promise<string[]> {
  const result = await testEnv.DB.prepare(
    `SELECT name FROM sqlite_master
     WHERE type = 'table'
       AND name NOT LIKE 'sqlite_%'
       AND name NOT LIKE '_cf_%'
       AND name <> 'd1_migrations'
     ORDER BY name`,
  ).all<{ name: string }>();
  return result.results.map((row) => row.name);
}

describe("D1 schema migrations", () => {
  it("upgrades from empty through every migration and remains idempotent", async () => {
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS.slice(0, 1));
    expect(await applicationTableNames()).toHaveLength(57);
    expect(
      await testEnv.DB.prepare("SELECT COUNT(*) AS total FROM menu_categories").first(
        "total",
      ),
    ).toBe(0);

    await testEnv.DB.prepare(
      `INSERT INTO menu_categories
       (name, description, active, display_order)
       VALUES ('Drinks', 'Legacy value', 0, 99)`,
    ).run();
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
    await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);

    const foreignKeyErrors = await testEnv.DB.prepare("PRAGMA foreign_key_check").all();
    expect(foreignKeyErrors.results).toEqual([]);
    const ledger = await testEnv.DB.prepare(
      "SELECT name FROM d1_migrations ORDER BY id",
    ).all<{ name: string }>();
    expect(ledger.results.map((row) => row.name)).toEqual([
      "0001_initial_schema.sql",
      "0002_seed_pos_categories.sql",
      "0003_voice_audio_r2_metadata.sql",
    ]);
    expect(await applicationTableNames()).toHaveLength(58);
    const orderIndexes = await testEnv.DB.prepare(
      "PRAGMA index_list('inventory_purchase_orders')",
    ).all<{ name: string; unique: number }>();
    expect(orderIndexes.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "ix_inventory_purchase_orders_import_source_hash",
          unique: 1,
        }),
        expect.objectContaining({
          name: "ix_inventory_purchase_orders_external_reference",
          unique: 0,
        }),
      ]),
    );
    expect(
      await testEnv.DB.prepare("SELECT COUNT(*) AS total FROM menu_categories").first(
        "total",
      ),
    ).toBe(11);
    await expect(
      testEnv.DB.prepare(
        "SELECT description, active, display_order FROM menu_categories WHERE name = 'Drinks'",
      ).first(),
    ).resolves.toEqual({
      description: "POS V1 category",
      active: 1,
      display_order: 1,
    });
  });
});
