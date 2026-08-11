(function attachEasyInventoryCore(root) {
  const visibleColumns = [
    "name", "category", "base_unit", "location", "purchase_unit",
    "pack_quantity", "pack_cost", "opening_quantity", "par_quantity",
  ];
  const aliases = {
    name: ["item", "item name", "name", "product", "product name"],
    category: ["category", "type", "group"],
    base_unit: ["count unit", "base unit", "unit", "count uom"],
    location: ["location", "area", "storage location"],
    purchase_unit: ["purchase unit", "pack unit", "receiving unit"],
    pack_quantity: ["units pack", "units per pack", "pack qty", "pack quantity", "case size"],
    pack_cost: ["pack cost", "purchase cost", "cost", "case cost", "unit price"],
    opening_quantity: ["opening qty", "opening quantity", "starting qty", "on hand"],
    par_quantity: ["par", "par qty", "par quantity", "target"],
    sku: ["sku", "barcode", "item number"],
    vendor_sku: ["vendor sku", "supplier sku"],
    minimum_quantity: ["minimum", "min", "minimum qty"],
    maximum_quantity: ["maximum", "max", "maximum qty"],
    shelf_life_days: ["shelf life", "shelf life days"],
    vendor: ["vendor", "supplier", "preferred vendor"],
  };

  const normalizeHeader = (value) => String(value || "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

  function parseMoneyCents(value) {
    if (value === null || value === undefined || String(value).trim() === "") return null;
    const cleaned = String(value).replace(/[$,\s]/g, "");
    if (!/^-?\d+(\.\d{0,2})?$/.test(cleaned)) return NaN;
    const negative = cleaned.startsWith("-");
    const [whole, fraction = ""] = cleaned.replace("-", "").split(".");
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
    return negative ? -cents : cents;
  }

  function calculateBaseCost(packCostCents, packQuantity) {
    const cost = Number(packCostCents);
    const quantity = Number(packQuantity);
    return Number.isFinite(cost) && Number.isFinite(quantity) && quantity > 0
      ? Math.round(cost / quantity)
      : 0;
  }

  function headerMap(cells) {
    const mapped = {};
    cells.forEach((cell, index) => {
      const normalized = normalizeHeader(cell);
      for (const [field, values] of Object.entries(aliases)) {
        if (values.includes(normalized)) mapped[field] = index;
      }
    });
    return mapped;
  }

  function parseSpreadsheet(text, defaults = {}) {
    const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n")
      .map((line) => line.split("\t")).filter((cells) => cells.some((cell) => cell.trim()));
    if (!lines.length) return [];
    const mapped = headerMap(lines[0]);
    const hasHeader = Object.keys(mapped).length >= 2 || mapped.name === 0;
    const columns = hasHeader ? mapped : Object.fromEntries(visibleColumns.map((field, index) => [field, index]));
    const data = hasHeader ? lines.slice(1) : lines;
    return data.map((cells, index) => {
      const value = (field) => columns[field] === undefined ? "" : String(cells[columns[field]] || "").trim();
      const numeric = (field) => value(field) === "" ? null : Number(value(field).replace(/,/g, ""));
      return {
        client_row_id: `paste-${Date.now()}-${index}`,
        name: value("name"),
        category: value("category") || defaults.category || null,
        base_unit: value("base_unit") || defaults.base_unit || "unit",
        location_name: value("location") || null,
        location_id: defaults.location_id || null,
        purchase_unit: value("purchase_unit") || defaults.purchase_unit || defaults.base_unit || "unit",
        pack_quantity: numeric("pack_quantity") ?? Number(defaults.pack_quantity || 1),
        pack_cost_cents: parseMoneyCents(value("pack_cost")),
        opening_quantity: numeric("opening_quantity"),
        par_quantity: numeric("par_quantity") ?? 0,
        minimum_quantity: numeric("minimum_quantity") ?? 0,
        maximum_quantity: numeric("maximum_quantity"),
        sku: value("sku") || null,
        vendor_sku: value("vendor_sku") || null,
        shelf_life_days: numeric("shelf_life_days"),
        vendor_name: value("vendor") || null,
        preferred_vendor_id: defaults.preferred_vendor_id || null,
        _paste_row: index + (hasHeader ? 2 : 1),
      };
    });
  }

  function nextGridCell(row, column, key, rowCount, columnCount) {
    let nextRow = row;
    let nextColumn = column;
    if (key === "ArrowRight" || key === "Tab") nextColumn += 1;
    if (key === "ArrowLeft" || key === "ShiftTab") nextColumn -= 1;
    if (key === "ArrowDown" || key === "Enter") nextRow += 1;
    if (key === "ArrowUp") nextRow -= 1;
    if (nextColumn >= columnCount) { nextColumn = 0; nextRow += 1; }
    if (nextColumn < 0) { nextColumn = columnCount - 1; nextRow -= 1; }
    return {
      row: Math.max(0, Math.min(rowCount - 1, nextRow)),
      column: Math.max(0, Math.min(columnCount - 1, nextColumn)),
      appendRow: nextRow >= rowCount,
    };
  }

  function draftStorageKey(userId, locationId, mode) {
    return `easy-inventory-draft:${userId || "manager"}:${locationId || "none"}:${mode || "quick"}`;
  }

  function serializeDraft(rows, pendingKey) {
    return JSON.stringify({ rows, pendingKey: pendingKey || null, savedAt: new Date().toISOString() });
  }

  function restoreDraft(value) {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed.rows) ? parsed : null;
    } catch {
      return null;
    }
  }

  root.EasyInventoryCore = {
    aliases,
    visibleColumns,
    normalizeHeader,
    parseMoneyCents,
    calculateBaseCost,
    parseSpreadsheet,
    nextGridCell,
    draftStorageKey,
    serializeDraft,
    restoreDraft,
  };
}(typeof globalThis === "undefined" ? this : globalThis));
