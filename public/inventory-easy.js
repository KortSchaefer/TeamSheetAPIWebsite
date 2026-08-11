(function inventoryEasyManager() {
  const core = globalThis.EasyInventoryCore;
  const easy = {
    initialized: false,
    authorized: false,
    user: null,
    mode: "quick",
    bootstrap: null,
    rows: [],
    selected: new Set(),
    expanded: new Set(),
    preview: null,
    previewPurpose: null,
    pasteRows: [],
    pendingKey: null,
    restoredLocation: null,
    catalogMatches: new Map(),
    catalogTimer: null,
    scrollSync: false,
  };
  const element = (id) => document.getElementById(id);
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const numericFields = new Set(["pack_quantity", "opening_quantity", "par_quantity", "minimum_quantity", "maximum_quantity", "shelf_life_days"]);
  const editableFields = ["name", "category", "base_unit", "location_id", "purchase_unit", "pack_quantity", "pack_cost_cents", "opening_quantity", "par_quantity", "preferred_vendor_id"];

  function draftKey(locationId, mode = easy.mode) {
    return core.draftStorageKey(easy.user?.id, locationId, mode);
  }

  function defaults() {
    return {
      location_id: Number(element("easy-default-location").value) || null,
      category: element("easy-default-category").value.trim() || null,
      base_unit: element("easy-default-base-unit").value.trim() || "unit",
      purchase_unit: element("easy-default-purchase-unit").value.trim() || "unit",
      pack_quantity: Number(element("easy-default-pack").value) || 1,
      preferred_vendor_id: Number(element("easy-default-vendor").value) || null,
    };
  }

  function blankRow(overrides = {}) {
    const base = defaults();
    return {
      client_row_id: `new-${crypto.randomUUID()}`,
      action: "CREATE",
      inventory_item_id: null,
      catalog_id: null,
      name: "",
      category: base.category,
      sku: null,
      base_unit: base.base_unit,
      location_id: base.location_id,
      purchase_unit: base.purchase_unit,
      pack_quantity: base.pack_quantity,
      pack_cost_cents: null,
      opening_quantity: null,
      minimum_quantity: 0,
      par_quantity: 0,
      maximum_quantity: null,
      preferred_vendor_id: base.preferred_vendor_id,
      vendor_sku: null,
      shelf_life_days: null,
      quantity_on_hand: 0,
      has_balance: false,
      _dirty: true,
      _errors: [],
      ...overrides,
    };
  }

  function options(rows, selected, emptyLabel) {
    return `<option value="">${escapeHtml(emptyLabel)}</option>` + rows.map((row) =>
      `<option value="${row.id}" ${Number(selected) === Number(row.id) ? "selected" : ""}>${escapeHtml(row.name)}</option>`
    ).join("");
  }

  function validateRow(row) {
    const errors = [];
    if (!String(row.name || "").trim()) errors.push("Name is required");
    if (!row.location_id) errors.push("Location is required");
    if (!String(row.base_unit || "").trim()) errors.push("Count unit is required");
    if (!(Number(row.pack_quantity) > 0)) errors.push("Pack size must be positive");
    if (row.pack_cost_cents !== null && (!Number.isFinite(Number(row.pack_cost_cents)) || Number(row.pack_cost_cents) < 0)) errors.push("Pack cost is invalid");
    for (const field of ["opening_quantity", "minimum_quantity", "par_quantity", "maximum_quantity"]) {
      if (row[field] !== null && row[field] !== "" && Number(row[field]) < 0) errors.push("Quantities cannot be negative");
    }
    if (row.maximum_quantity !== null && row.maximum_quantity !== "" && Number(row.maximum_quantity) < Math.max(Number(row.minimum_quantity || 0), Number(row.par_quantity || 0))) errors.push("Maximum must be at least min and par");
    if (row.has_balance && Number(row.opening_quantity || 0) > 0) errors.push("Use a count sheet to change existing on-hand stock");
    row._errors = errors;
    return errors;
  }

  function dirtyRows() {
    return easy.rows.filter((row) => row._dirty && String(row.name || "").trim());
  }

  function filteredRows() {
    if (easy.mode === "quick") return easy.rows;
    const search = element("easy-search").value.trim().toLowerCase();
    const filter = element("easy-filter").value;
    return easy.rows.filter((row) => {
      if (search && !`${row.name} ${row.category || ""} ${row.sku || ""}`.toLowerCase().includes(search)) return false;
      if (filter === "missing_cost" && Number(row.pack_cost_cents) > 0) return false;
      if (filter === "missing_location" && row.has_balance) return false;
      if (filter === "missing_vendor" && row.preferred_vendor_id) return false;
      if (filter === "incomplete" && row.has_balance && Number(row.pack_cost_cents) > 0 && row.preferred_vendor_id && Number(row.par_quantity) > 0) return false;
      return true;
    });
  }

  function rowMarkup(row, rowIndex) {
    validateRow(row);
    const statusId = `easy-status-${row.client_row_id.replace(/[^a-z0-9_-]/gi, "-")}`;
    const baseCost = core.calculateBaseCost(row.pack_cost_cents || 0, row.pack_quantity || 1);
    const status = row._errors.length
      ? `<div class="easy-row-status error" id="${statusId}" role="alert">${escapeHtml(row._errors.join(" · "))}</div>`
      : row._warnings?.length
        ? `<div class="easy-row-status warning" id="${statusId}">${escapeHtml(row._warnings.join(" · "))}</div>`
        : `<span class="status ${row.inventory_item_id ? "healthy" : "on_target"}" id="${statusId}">${row.inventory_item_id ? escapeHtml(String(row.action || "UPDATE").replaceAll("_", " ")) : "NEW"}</span>`;
    const openingDisabled = row.has_balance ? "disabled" : "";
    const rowClass = `${row._errors.length ? "invalid" : ""} ${row._dirty ? "dirty" : ""}`;
    const current = row.has_balance ? `<div class="easy-current">Current: ${quantity(row.quantity_on_hand)} ${escapeHtml(row.base_unit)}</div>` : "";
    const main = `<tr class="${rowClass}" data-easy-row="${escapeHtml(row.client_row_id)}" aria-rowindex="${rowIndex + 2}" aria-invalid="${row._errors.length ? "true" : "false"}">
      <td data-label="Select"><input type="checkbox" data-select-row aria-label="Select ${escapeHtml(row.name || "new row")}" ${easy.selected.has(row.client_row_id) ? "checked" : ""}></td>
      <td data-label="Item"><input data-field="name" data-col="0" list="easy-item-list" maxlength="150" value="${escapeHtml(row.name || "")}" aria-label="Item name" aria-describedby="${statusId}">${current}</td>
      <td data-label="Category"><input data-field="category" data-col="1" list="easy-category-list" maxlength="100" value="${escapeHtml(row.category || "")}" aria-label="Category"></td>
      <td data-label="Count unit"><input data-field="base_unit" data-col="2" maxlength="30" value="${escapeHtml(row.base_unit || "unit")}" aria-label="Count unit"></td>
      <td data-label="Location"><select data-field="location_id" data-col="3" aria-label="Location">${options(easy.bootstrap.locations, row.location_id, "Choose location")}</select></td>
      <td data-label="Purchase unit"><input data-field="purchase_unit" data-col="4" maxlength="30" value="${escapeHtml(row.purchase_unit || "")}" aria-label="Purchase unit"></td>
      <td data-label="Units per pack"><input data-field="pack_quantity" data-col="5" type="number" min="0.0001" step="0.0001" value="${row.pack_quantity ?? 1}" aria-label="Units per pack"></td>
      <td data-label="Pack cost"><input data-field="pack_cost_cents" data-col="6" inputmode="decimal" value="${row.pack_cost_cents === null || row.pack_cost_cents === undefined ? "" : (Number(row.pack_cost_cents) / 100).toFixed(2)}" placeholder="0.00" aria-label="Pack cost in dollars"></td>
      <td data-label="Cost per count unit"><div class="easy-cost"><strong>${unitMoney(baseCost)}</strong><small>per ${escapeHtml(row.base_unit || "unit")}</small></div></td>
      <td data-label="Opening quantity"><input data-field="opening_quantity" data-col="7" type="number" min="0" step="0.0001" value="${row.opening_quantity ?? ""}" ${openingDisabled} aria-label="Opening quantity"></td>
      <td data-label="Par"><input data-field="par_quantity" data-col="8" type="number" min="0" step="0.0001" value="${row.par_quantity ?? 0}" aria-label="Par quantity"></td>
      <td data-label="Vendor"><select data-field="preferred_vendor_id" data-col="9" aria-label="Preferred vendor">${options(easy.bootstrap.vendors, row.preferred_vendor_id, "No preferred vendor")}</select></td>
      <td data-label="Setup">${status}</td>
      <td data-label="Tools"><button class="btn secondary small" type="button" data-more>${easy.expanded.has(row.client_row_id) ? "Less" : "More"}</button>${!row.inventory_item_id ? `<button class="icon-btn" type="button" data-remove aria-label="Remove row">×</button>` : ""}</td>
    </tr>`;
    if (!easy.expanded.has(row.client_row_id)) return main;
    return `${main}<tr class="easy-more-row" data-easy-more="${escapeHtml(row.client_row_id)}"><td colspan="14"><div class="easy-more"><div class="easy-more-grid">
      <label>SKU / barcode<input data-extra-field="sku" maxlength="100" value="${escapeHtml(row.sku || "")}"></label>
      <label>Vendor SKU<input data-extra-field="vendor_sku" maxlength="100" value="${escapeHtml(row.vendor_sku || "")}"></label>
      <label>Minimum<input data-extra-field="minimum_quantity" type="number" min="0" step="0.0001" value="${row.minimum_quantity ?? 0}"></label>
      <label>Maximum<input data-extra-field="maximum_quantity" type="number" min="0" step="0.0001" value="${row.maximum_quantity ?? ""}"></label>
      <label>Shelf life (days)<input data-extra-field="shelf_life_days" type="number" min="0" step="1" value="${row.shelf_life_days ?? ""}"></label>
      <label>Catalog ID<input data-extra-field="catalog_id" maxlength="150" value="${escapeHtml(row.catalog_id || "")}" placeholder="Optional"></label>
    </div></div></td></tr>`;
  }

  function updateScrollNavigation() {
    const wrap = element("easy-table-wrap");
    const grid = element("easy-grid");
    const nav = element("easy-scroll-nav");
    const proxy = element("easy-scroll-proxy");
    if (!wrap || !grid || !nav || !proxy) return;
    const overflow = grid.scrollWidth > wrap.clientWidth + 2 && window.innerWidth > 700;
    nav.hidden = !overflow;
    if (!overflow) {
      wrap.classList.remove("can-scroll-left", "can-scroll-right");
      return;
    }
    element("easy-scroll-sizer").style.width = `${grid.scrollWidth}px`;
    const maximum = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    const edgeTolerance = 24;
    wrap.classList.toggle("can-scroll-left", wrap.scrollLeft > 2);
    wrap.classList.toggle("can-scroll-right", wrap.scrollLeft < maximum - edgeTolerance);
    element("easy-scroll-left").disabled = wrap.scrollLeft <= 2;
    element("easy-scroll-right").disabled = wrap.scrollLeft >= maximum - edgeTolerance;
  }

  function syncHorizontalScroll(source, target) {
    if (easy.scrollSync) return;
    easy.scrollSync = true;
    const sourceMaximum = Math.max(1, source.scrollWidth - source.clientWidth);
    const targetMaximum = Math.max(0, target.scrollWidth - target.clientWidth);
    target.scrollLeft = (source.scrollLeft / sourceMaximum) * targetMaximum;
    requestAnimationFrame(() => {
      easy.scrollSync = false;
      updateScrollNavigation();
    });
  }

  function scrollGridPage(direction) {
    const wrap = element("easy-table-wrap");
    wrap.scrollTo({ left: wrap.scrollLeft + direction * Math.max(260, wrap.clientWidth * 0.72), behavior: "smooth" });
  }

  function renderRows() {
    const rows = filteredRows();
    element("easy-grid").setAttribute("aria-rowcount", String(rows.length + 1));
    element("easy-grid").setAttribute("aria-colcount", "14");
    element("easy-grid-body").innerHTML = rows.length
      ? rows.map(rowMarkup).join("")
      : `<tr><td colspan="14" class="easy-empty">No inventory rows match this view.</td></tr>`;
    updateSummary();
    requestAnimationFrame(updateScrollNavigation);
  }

  function updateSummary() {
    const dirty = dirtyRows();
    const invalid = dirty.filter((row) => validateRow(row).length).length;
    const created = dirty.filter((row) => !row.inventory_item_id).length;
    const modified = dirty.length - created;
    element("easy-savebar").hidden = !dirty.length;
    element("easy-save-summary").innerHTML = `${created} new · ${modified} modified · ${invalid} invalid<small>${easy.selected.size} selected · Every valid row saves together.</small>`;
    element("easy-save").disabled = !dirty.length || invalid > 0;
  }

  function persistDraft() {
    if (!easy.bootstrap) return;
    localStorage.setItem(
      draftKey(easy.bootstrap.location_id),
      core.serializeDraft(easy.rows, easy.pendingKey),
    );
  }

  function resolvePastedRows(rows) {
    const locationByName = new Map(easy.bootstrap.locations.map((row) => [core.normalizeHeader(row.name), row.id]));
    const vendorByName = new Map(easy.bootstrap.vendors.map((row) => [core.normalizeHeader(row.name), row.id]));
    return rows.map((row) => ({
      ...blankRow(row),
      location_id: row.location_name ? locationByName.get(core.normalizeHeader(row.location_name)) || null : row.location_id,
      preferred_vendor_id: row.vendor_name ? vendorByName.get(core.normalizeHeader(row.vendor_name)) || null : row.preferred_vendor_id,
      _dirty: true,
    }));
  }

  function apiRows(rows) {
    return rows.map((row) => ({
      client_row_id: row.client_row_id,
      action: row.action || null,
      inventory_item_id: row.inventory_item_id || null,
      catalog_id: row.catalog_id || null,
      name: String(row.name || "").trim(),
      category: row.category || null,
      sku: row.sku || null,
      base_unit: String(row.base_unit || "unit").trim(),
      location_id: Number(row.location_id) || null,
      purchase_unit: row.purchase_unit || null,
      pack_quantity: Number(row.pack_quantity || 1),
      pack_cost_cents: row.pack_cost_cents === null || row.pack_cost_cents === "" ? null : Number(row.pack_cost_cents),
      opening_quantity: row.opening_quantity === null || row.opening_quantity === "" ? null : Number(row.opening_quantity),
      minimum_quantity: Number(row.minimum_quantity || 0),
      par_quantity: Number(row.par_quantity || 0),
      maximum_quantity: row.maximum_quantity === null || row.maximum_quantity === "" ? null : Number(row.maximum_quantity),
      preferred_vendor_id: Number(row.preferred_vendor_id) || null,
      vendor_sku: row.vendor_sku || null,
      shelf_life_days: row.shelf_life_days === null || row.shelf_life_days === "" ? null : Number(row.shelf_life_days),
    }));
  }

  async function previewRows(rows, purpose) {
    const data = await json(await authFetch("/inventory/easy-manager/preview", { method: "POST", body: JSON.stringify({ rows: apiRows(rows) }) }));
    easy.preview = data;
    easy.previewPurpose = purpose;
    const openingValue = data.rows.reduce((total, row) => total + Number(row.opening_quantity || 0) * Number(row.base_unit_cost_cents || 0), 0);
    element("easy-preview-summary").innerHTML = `<div class="summary-strip"><div class="summary-chip"><span>Rows</span><strong>${data.row_count}</strong></div><div class="summary-chip"><span>New</span><strong>${data.rows.filter((row) => row.action === "CREATE").length}</strong></div><div class="summary-chip"><span>Existing</span><strong>${data.rows.filter((row) => row.action !== "CREATE").length}</strong></div><div class="summary-chip"><span>Opening value</span><strong>${unitMoney(openingValue)}</strong></div></div>`;
    element("easy-preview-list").innerHTML = data.rows.map((row) => `<div class="easy-preview-row ${row.errors.length ? "invalid" : ""}"><strong>${escapeHtml(row.name || `Row ${row.row_number}`)}</strong> <span class="status ${row.errors.length ? "out" : "healthy"}">${row.errors.length ? "NEEDS FIX" : escapeHtml(row.action.replaceAll("_", " "))}</span><div class="meta">${escapeHtml(row.purchase_unit)} of ${quantity(row.pack_quantity)} · ${unitMoney(row.pack_cost_cents)} · ${escapeHtml(row.base_unit)} cost ${unitMoney(row.base_unit_cost_cents)}</div>${row.warnings.length ? `<div class="easy-row-status warning">${escapeHtml(row.warnings.join(" · "))}</div>` : ""}${row.errors.length ? `<div class="easy-row-status error">${escapeHtml(row.errors.join(" · "))}</div>` : ""}</div>`).join("");
    element("easy-confirm-save").disabled = !data.valid;
    element("easy-confirm-save").textContent = purpose === "paste" ? "Add rows to grid" : "Save all changes";
    element("easy-preview-dialog").showModal();
    return data;
  }

  async function savePreview() {
    if (!easy.preview?.valid) return;
    if (easy.previewPurpose === "paste") {
      easy.rows.push(...easy.preview.rows.map((row) => ({ ...row, _dirty: true, _errors: row.errors, _warnings: row.warnings })));
      element("easy-paste-input").value = "";
      element("easy-paste-panel").hidden = true;
      element("easy-preview-dialog").close();
      persistDraft();
      renderRows();
      focusNewRow();
      return;
    }
    const rows = easy.preview.rows;
    const nonzero = rows.filter((row) => Number(row.opening_quantity || 0) > 0);
    if (nonzero.length && !confirm(`Record audited opening quantities for ${nonzero.length} item${nonzero.length === 1 ? "" : "s"}?`)) return;
    easy.pendingKey ||= crypto.randomUUID();
    element("easy-confirm-save").disabled = true;
    try {
      const result = await json(await authFetch("/inventory/easy-manager/commit", { method: "POST", body: JSON.stringify({ idempotency_key: easy.pendingKey, rows }) }));
      localStorage.removeItem(draftKey(easy.bootstrap.location_id));
      easy.pendingKey = null;
      element("easy-preview-dialog").close();
      toast(`${result.created_count} created, ${result.updated_count} updated, ${result.stocked_count} stocked.`);
      await load(easy.bootstrap.location_id, true);
      await loadDashboard();
    } catch (error) {
      toast(error.message, true);
      element("easy-confirm-save").disabled = false;
      persistDraft();
    }
  }

  async function load(locationId, force = false) {
    if (!easy.authorized) return;
    if (!force && easy.bootstrap?.location_id === locationId) return;
    const data = await json(await authFetch(`/inventory/easy-manager?location_id=${locationId}`));
    easy.bootstrap = data;
    easy.selected.clear();
    easy.expanded.clear();
    element("easy-default-location").innerHTML = options(data.locations, locationId, "Choose location");
    element("easy-default-vendor").innerHTML = options(data.vendors, null, "No preferred vendor");
    element("easy-category-list").innerHTML = data.categories.map((category) => `<option value="${escapeHtml(category)}"></option>`).join("");
    let itemList = element("easy-item-list");
    if (!itemList) { itemList = document.createElement("datalist"); itemList.id = "easy-item-list"; document.body.appendChild(itemList); }
    itemList.innerHTML = data.rows.map((row) => `<option value="${escapeHtml(row.name)}">${escapeHtml(row.sku || row.category || "Existing item")}</option>`).join("");
    const stored = localStorage.getItem(draftKey(locationId));
    if (stored) {
      try {
        const draft = core.restoreDraft(stored);
        if (!draft) throw new Error("Invalid inventory draft");
        easy.rows = draft.rows?.length ? draft.rows : (easy.mode === "quick" ? [blankRow()] : []);
        easy.pendingKey = draft.pendingKey || null;
        toast("Restored your unsaved inventory rows.");
      } catch {
        easy.rows = easy.mode === "quick" ? [blankRow()] : data.rows.map((row) => ({ ...clone(row), _dirty: false, _errors: [], _warnings: [] }));
      }
    } else {
      easy.rows = easy.mode === "quick"
        ? [blankRow()]
        : data.rows.map((row) => ({ ...clone(row), _dirty: false, _errors: [], _warnings: [] }));
    }
    renderRows();
  }

  async function switchMode(mode) {
    if (mode === easy.mode) return true;
    if (dirtyRows().length && !confirm("Switch inventory views? Your unsaved draft will be kept.")) return false;
    persistDraft();
    easy.mode = mode;
    document.querySelectorAll("[data-easy-mode]").forEach((button) => button.classList.toggle("active", button.dataset.easyMode === mode));
    element("easy-search").hidden = mode === "quick";
    element("easy-filter").hidden = mode === "quick";
    element("easy-paste-toggle").hidden = mode !== "quick";
    element("easy-add-row").hidden = mode !== "quick";
    await load(easy.bootstrap.location_id, true);
    return true;
  }

  function scheduleCatalogSearch(value) {
    clearTimeout(easy.catalogTimer);
    const search = String(value || "").trim();
    if (search.length < 2) return;
    easy.catalogTimer = setTimeout(async () => {
      try {
        const data = await json(await authFetch(`/ingredient-catalog?search=${encodeURIComponent(search)}&limit=10`));
        easy.catalogMatches = new Map(data.items.map((item) => [core.normalizeHeader(item.name), item]));
        const existing = easy.bootstrap.rows.map((row) => `<option value="${escapeHtml(row.name)}">${escapeHtml(row.sku || row.category || "Existing inventory")}</option>`);
        const catalog = data.items.map((item) => `<option value="${escapeHtml(item.name)}">${escapeHtml(`${item.category || "Catalog"} · catalog`)}</option>`);
        element("easy-item-list").innerHTML = [...existing, ...catalog].join("");
      } catch {
        // Catalog suggestions are optional; server preview still performs matching.
      }
    }, 180);
  }

  function updateRowFromInput(input) {
    const container = input.closest("[data-easy-row]") || input.closest("[data-easy-more]");
    if (!container) return;
    const id = container.dataset.easyRow || container.dataset.easyMore;
    const row = easy.rows.find((candidate) => candidate.client_row_id === id);
    if (!row) return;
    const field = input.dataset.field || input.dataset.extraField;
    let value = input.value;
    if (field === "pack_cost_cents") value = core.parseMoneyCents(value);
    else if (numericFields.has(field)) value = value === "" ? null : Number(value);
    else if (["location_id", "preferred_vendor_id"].includes(field)) value = value ? Number(value) : null;
    row[field] = value;
    if (field === "name") {
      scheduleCatalogSearch(value);
      const catalog = easy.catalogMatches.get(core.normalizeHeader(value));
      if (!row.inventory_item_id && catalog) {
        row.catalog_id = catalog.external_id;
        if (!row.category) row.category = catalog.category || null;
      }
    }
    row._dirty = true;
    easy.pendingKey = null;
    validateRow(row);
    const main = element("easy-grid-body").querySelector(`[data-easy-row="${CSS.escape(id)}"]`);
    if (main) {
      const cost = main.querySelector(".easy-cost");
      if (cost) cost.innerHTML = `<strong>${unitMoney(core.calculateBaseCost(row.pack_cost_cents || 0, row.pack_quantity || 1))}</strong><small>per ${escapeHtml(row.base_unit || "unit")}</small>`;
      main.classList.toggle("invalid", row._errors.length > 0);
      main.classList.add("dirty");
      main.setAttribute("aria-invalid", row._errors.length ? "true" : "false");
      const statusId = `easy-status-${row.client_row_id.replace(/[^a-z0-9_-]/gi, "-")}`;
      const statusCell = main.querySelector('[data-label="Setup"]');
      if (statusCell) {
        statusCell.innerHTML = row._errors.length
          ? `<div class="easy-row-status error" id="${statusId}" role="alert">${escapeHtml(row._errors.join(" · "))}</div>`
          : row._warnings?.length
            ? `<div class="easy-row-status warning" id="${statusId}">${escapeHtml(row._warnings.join(" · "))}</div>`
            : `<span class="status ${row.inventory_item_id ? "healthy" : "on_target"}" id="${statusId}">${row.inventory_item_id ? escapeHtml(String(row.action || "UPDATE").replaceAll("_", " ")) : "NEW"}</span>`;
      }
    }
    persistDraft();
    updateSummary();
  }

  function focusNewRow() {
    setTimeout(() => {
      const inputs = element("easy-grid-body")?.querySelectorAll('[data-field="name"]');
      inputs?.[inputs.length - 1]?.focus();
    }, 60);
  }

  async function open() {
    if (!easy.authorized) return;
    const locationId = Number(element("easy-default-location").value) || state.locations[0]?.id || easy.bootstrap?.location_id;
    if (locationId) await load(locationId);
  }

  async function addItem() {
    if (!(await switchMode("quick"))) return;
    await open();
    if (!easy.rows.some((row) => !String(row.name || "").trim())) easy.rows.push(blankRow());
    renderRows();
    focusNewRow();
  }

  async function showMissingCosts() {
    if (!(await switchMode("edit"))) return;
    await open();
    element("easy-filter").value = "missing_cost";
    renderRows();
  }

  function displayCellValue(row, field) {
    if (field === "pack_cost_cents") return row[field] === null ? "" : (Number(row[field]) / 100).toFixed(2);
    if (field === "location_id") return easy.bootstrap.locations.find((item) => Number(item.id) === Number(row[field]))?.name || "";
    if (field === "preferred_vendor_id") return easy.bootstrap.vendors.find((item) => Number(item.id) === Number(row[field]))?.name || "";
    return row[field] ?? "";
  }

  function gridValue(field, raw) {
    if (field === "pack_cost_cents") return core.parseMoneyCents(raw);
    if (numericFields.has(field)) return raw === "" ? null : Number(raw.replace(/,/g, ""));
    if (field === "location_id") return easy.bootstrap.locations.find((item) => core.normalizeHeader(item.name) === core.normalizeHeader(raw))?.id || Number(raw) || null;
    if (field === "preferred_vendor_id") return easy.bootstrap.vendors.find((item) => core.normalizeHeader(item.name) === core.normalizeHeader(raw))?.id || Number(raw) || null;
    return raw;
  }

  function pasteIntoGrid(input, text) {
    const lines = String(text).replace(/\r\n?/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    const matrix = lines.map((line) => line.split("\t"));
    if (!matrix.length) return false;
    if (matrix.length === 1 && matrix[0].length === 1) return false;
    const visible = filteredRows();
    const sourceId = input.closest("[data-easy-row]").dataset.easyRow;
    const startRow = visible.findIndex((row) => row.client_row_id === sourceId);
    const startColumn = Number(input.dataset.col || 0);
    matrix.forEach((cells, rowOffset) => {
      while (startRow + rowOffset >= visible.length && easy.mode === "quick") {
        const added = blankRow();
        easy.rows.push(added);
        visible.push(added);
      }
      const row = visible[startRow + rowOffset];
      if (!row) return;
      cells.forEach((raw, columnOffset) => {
        const field = editableFields[startColumn + columnOffset];
        if (!field) return;
        row[field] = gridValue(field, raw.trim());
        row._dirty = true;
        validateRow(row);
      });
    });
    easy.pendingKey = null;
    persistDraft();
    renderRows();
    return true;
  }

  function openInline(kind) {
    element("easy-inline-title").textContent = kind === "location" ? "Add inventory location" : "Add vendor";
    element("easy-inline-body").innerHTML = kind === "location"
      ? `<form class="easy-inline-form" id="easy-inline-form"><label>Name<input id="easy-inline-name" maxlength="100" required autofocus></label><label>Description<textarea id="easy-inline-description"></textarea></label><button class="btn" type="submit">Create location</button></form>`
      : `<form class="easy-inline-form" id="easy-inline-form"><label>Name<input id="easy-inline-name" maxlength="150" required autofocus></label><label>Lead time (days)<input id="easy-inline-lead" type="number" min="0" value="1"></label><button class="btn" type="submit">Create vendor</button></form>`;
    element("easy-inline-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        if (kind === "location") {
          const created = await json(await authFetch("/inventory/locations", { method: "POST", body: JSON.stringify({ name: element("easy-inline-name").value, description: element("easy-inline-description").value || null, active: true }) }));
          element("easy-inline-dialog").close();
          state.locations.push(created);
          await load(created.id, true);
          toast(`Location ${created.name} created.`);
        } else {
          const created = await json(await authFetch("/inventory/vendors", { method: "POST", body: JSON.stringify({ name: element("easy-inline-name").value, contact_name: null, email: null, phone: null, lead_time_days: Number(element("easy-inline-lead").value || 0), active: true }) }));
          element("easy-inline-dialog").close();
          easy.bootstrap.vendors.push(created);
          element("easy-default-vendor").innerHTML = options(easy.bootstrap.vendors, created.id, "No preferred vendor");
          renderRows();
          toast(`Vendor ${created.name} created.`);
        }
      } catch (error) { toast(error.message, true); }
    });
    element("easy-inline-dialog").showModal();
  }

  function bindEvents() {
    const tableWrap = element("easy-table-wrap");
    const scrollProxy = element("easy-scroll-proxy");
    tableWrap.addEventListener("scroll", () => syncHorizontalScroll(tableWrap, scrollProxy));
    scrollProxy.addEventListener("scroll", () => syncHorizontalScroll(scrollProxy, tableWrap));
    tableWrap.addEventListener("wheel", (event) => {
      if (!event.shiftKey || Math.abs(event.deltaY) < Math.abs(event.deltaX)) return;
      event.preventDefault();
      tableWrap.scrollLeft += event.deltaY;
    }, { passive: false });
    element("easy-scroll-left").addEventListener("click", () => scrollGridPage(-1));
    element("easy-scroll-right").addEventListener("click", () => scrollGridPage(1));
    if (globalThis.ResizeObserver) {
      const scrollObserver = new ResizeObserver(updateScrollNavigation);
      scrollObserver.observe(tableWrap);
      scrollObserver.observe(element("easy-grid"));
    }
    document.querySelectorAll("[data-easy-mode]").forEach((button) => button.addEventListener("click", () => switchMode(button.dataset.easyMode)));
    element("easy-default-location").addEventListener("change", (event) => { persistDraft(); load(Number(event.target.value), true); });
    element("easy-search").addEventListener("input", renderRows);
    element("easy-filter").addEventListener("change", renderRows);
    element("easy-add-row").addEventListener("click", () => { easy.rows.push(blankRow()); renderRows(); persistDraft(); focusNewRow(); });
    element("easy-paste-toggle").addEventListener("click", () => { element("easy-paste-panel").hidden = false; element("easy-paste-input").focus(); });
    element("easy-paste-cancel").addEventListener("click", () => { element("easy-paste-panel").hidden = true; });
    element("easy-paste-preview").addEventListener("click", async () => {
      try {
        const parsed = core.parseSpreadsheet(element("easy-paste-input").value, defaults());
        if (!parsed.length) throw new Error("Paste at least one inventory row.");
        easy.pasteRows = resolvePastedRows(parsed);
        await previewRows(easy.pasteRows, "paste");
      } catch (error) { toast(error.message, true); }
    });
    element("easy-grid-body").addEventListener("input", (event) => {
      if (event.target.matches("[data-field],[data-extra-field]")) updateRowFromInput(event.target);
    });
    element("easy-grid-body").addEventListener("focusin", (event) => {
      if (event.target.matches("[data-field]")) event.target.dataset.focusValue = event.target.value;
    });
    element("easy-grid-body").addEventListener("paste", (event) => {
      const input = event.target.closest("[data-field]");
      if (input && pasteIntoGrid(input, event.clipboardData.getData("text/plain"))) event.preventDefault();
    });
    element("easy-grid-body").addEventListener("copy", (event) => {
      if (!easy.selected.size) return;
      const rows = filteredRows().filter((row) => easy.selected.has(row.client_row_id));
      event.clipboardData.setData("text/plain", rows.map((row) => editableFields.map((field) => displayCellValue(row, field)).join("\t")).join("\n"));
      event.preventDefault();
    });
    element("easy-grid-body").addEventListener("change", (event) => {
      if (event.target.matches("[data-field],[data-extra-field]")) updateRowFromInput(event.target);
      if (event.target.matches("[data-select-row]")) {
        const id = event.target.closest("[data-easy-row]").dataset.easyRow;
        event.target.checked ? easy.selected.add(id) : easy.selected.delete(id);
        updateSummary();
      }
    });
    element("easy-grid-body").addEventListener("click", (event) => {
      const rowElement = event.target.closest("[data-easy-row]");
      if (!rowElement) return;
      const id = rowElement.dataset.easyRow;
      if (event.target.closest("[data-more]")) { easy.expanded.has(id) ? easy.expanded.delete(id) : easy.expanded.add(id); renderRows(); }
      if (event.target.closest("[data-remove]")) { easy.rows = easy.rows.filter((row) => row.client_row_id !== id); if (!easy.rows.length) easy.rows.push(blankRow()); renderRows(); persistDraft(); }
    });
    element("easy-grid-body").addEventListener("keydown", (event) => {
      const input = event.target.closest("[data-field]");
      if (!input) return;
      if (event.altKey && ["ArrowLeft", "ArrowRight"].includes(event.key)) {
        event.preventDefault();
        scrollGridPage(event.key === "ArrowLeft" ? -1 : 1);
        return;
      }
      if (event.key === "F2") { input.select?.(); return; }
      if (event.key === "Escape") {
        if (input.dataset.focusValue !== undefined) {
          input.value = input.dataset.focusValue;
          updateRowFromInput(input);
        }
        input.blur();
        return;
      }
      const key = event.shiftKey && event.key === "Tab" ? "ShiftTab" : event.key;
      const arrow = key.startsWith("Arrow");
      if (arrow && input instanceof HTMLInputElement && ["ArrowLeft", "ArrowRight"].includes(key)) {
        const atBoundary = key === "ArrowLeft" ? input.selectionStart === 0 : input.selectionEnd === input.value.length;
        if (!atBoundary) return;
      }
      if (!["Enter", "Tab", "ShiftTab", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(key)) return;
      event.preventDefault();
      const rows = [...element("easy-grid-body").querySelectorAll("[data-easy-row]")];
      const rowIndex = rows.indexOf(input.closest("[data-easy-row]"));
      const column = Number(input.dataset.col || 0);
      const next = core.nextGridCell(rowIndex, column, key, rows.length, editableFields.length);
      if (next.appendRow && easy.mode === "quick") { easy.rows.push(blankRow()); renderRows(); focusNewRow(); return; }
      rows[next.row]?.querySelector(`[data-col="${next.column}"]`)?.focus();
    });
    element("easy-apply-defaults").addEventListener("click", () => {
      const values = defaults();
      easy.rows.filter((row) => easy.selected.has(row.client_row_id)).forEach((row) => { Object.assign(row, values, { _dirty: true }); });
      renderRows(); persistDraft();
    });
    element("easy-save").addEventListener("click", async () => { try { await previewRows(dirtyRows(), "save"); } catch (error) { toast(error.message, true); } });
    element("easy-discard").addEventListener("click", async () => { if (dirtyRows().length && !confirm("Discard all unsaved inventory changes?")) return; localStorage.removeItem(draftKey(easy.bootstrap.location_id)); easy.pendingKey = null; await load(easy.bootstrap.location_id, true); });
    element("easy-confirm-save").addEventListener("click", savePreview);
    ["easy-preview-close", "easy-preview-cancel"].forEach((id) => element(id).addEventListener("click", () => element("easy-preview-dialog").close()));
    element("easy-new-location").addEventListener("click", () => openInline("location"));
    element("easy-new-vendor").addEventListener("click", () => openInline("vendor"));
    element("easy-inline-close").addEventListener("click", () => element("easy-inline-dialog").close());
    window.addEventListener("beforeunload", (event) => { if (!dirtyRows().length) return; event.preventDefault(); event.returnValue = ""; });
  }

  async function initialize() {
    if (easy.initialized) return;
    easy.initialized = true;
    try {
      easy.user = await json(await authFetch("/auth/me"));
      easy.authorized = ["ADMIN", "MANAGER"].includes(easy.user.role);
      document.body.classList.toggle("easy-manager-authorized", easy.authorized);
      element("easy-manager-nav").hidden = !easy.authorized;
      element("quick-item").hidden = !easy.authorized;
      if (!easy.authorized) return;
      bindEvents();
      element("easy-search").hidden = true;
      element("easy-filter").hidden = true;
    } catch (error) {
      element("easy-manager-nav").hidden = true;
    }
  }

  window.EasyInventoryManager = { open, addItem, showMissingCosts, focusNewRow, initialize };
  initialize();
}());
