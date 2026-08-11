import { beforeAll, describe, expect, it } from "vitest";

interface EasyInventoryCoreApi {
  parseMoneyCents(value: unknown): number | null;
  calculateBaseCost(packCostCents: number, packQuantity: number): number;
  parseSpreadsheet(text: string, defaults?: Record<string, unknown>): Array<Record<string, unknown>>;
  nextGridCell(row: number, column: number, key: string, rowCount: number, columnCount: number): { row: number; column: number; appendRow: boolean };
  draftStorageKey(userId: number, locationId: number, mode: string): string;
  serializeDraft(rows: Array<Record<string, unknown>>, pendingKey: string | null): string;
  restoreDraft(value: string): { rows: Array<Record<string, unknown>>; pendingKey: string | null } | null;
}

let core: EasyInventoryCoreApi;

beforeAll(async () => {
  // @ts-expect-error The browser asset intentionally exposes a global rather than a typed module API.
  await import("../public/inventory-easy-core.js");
  core = (globalThis as typeof globalThis & { EasyInventoryCore: EasyInventoryCoreApi }).EasyInventoryCore;
});

describe("Easy Inventory Manager browser core", () => {
  it("parses currency and calculates pack-to-count cost", () => {
    expect(core.parseMoneyCents("$24.00")).toBe(2400);
    expect(core.parseMoneyCents("bad")).toBeNaN();
    expect(core.calculateBaseCost(2400, 12)).toBe(200);
  });

  it("parses header and positional spreadsheet rows", () => {
    const headed = core.parseSpreadsheet("Item\tCount Unit\tUnits per Pack\tPack Cost\nLimes\teach\t20\t$10.00", { location_id: 10 });
    expect(headed).toEqual([expect.objectContaining({ name: "Limes", base_unit: "each", pack_quantity: 20, pack_cost_cents: 1000, location_id: 10 })]);
    const positional = core.parseSpreadsheet("Milk\tDairy\tgallon\tWalk-In\tcase\t4\t20.00\t2\t12", { location_id: 10 });
    expect(positional).toEqual([expect.objectContaining({ name: "Milk", category: "Dairy", pack_quantity: 4, opening_quantity: 2, par_quantity: 12 })]);
  });

  it("moves through the editable grid and reports append", () => {
    expect(core.nextGridCell(0, 1, "Enter", 2, 10)).toEqual({ row: 1, column: 1, appendRow: false });
    expect(core.nextGridCell(1, 9, "Tab", 2, 10)).toEqual({ row: 1, column: 0, appendRow: true });
  });

  it("restores user, location, and mode-scoped drafts", () => {
    expect(core.draftStorageKey(42, 7, "edit")).toBe("easy-inventory-draft:42:7:edit");
    const serialized = core.serializeDraft([{ client_row_id: "draft-1", name: "Draft Limes" }], "retry-key");
    expect(core.restoreDraft(serialized)).toMatchObject({
      pendingKey: "retry-key",
      rows: [{ client_row_id: "draft-1", name: "Draft Limes" }],
    });
    expect(core.restoreDraft("not-json")).toBeNull();
  });
});
