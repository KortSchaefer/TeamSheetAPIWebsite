import { describe, expect, it } from "vitest";
import html from "../public/inventory-count.html?raw";

describe("Inventory count browser refresh", () => {
  it("reloads current PAR values without discarding unsaved counts", () => {
    expect(html).toContain('cache: "no-store"');
    expect(html).toContain("async function refreshOpenSheet()");
    expect(html).toContain("state.sheet = mergePendingIntoSheet(current)");
    expect(html).toContain('window.addEventListener("focus", refreshOpenSheet)');
    expect(html).toContain('document.addEventListener("visibilitychange"');
  });
});
