import { apiError, jsonResponse, methodNotAllowed, validationError } from "../http";
import type { RuntimeBindings } from "../runtime";
import {
  authenticateRequest,
  requireManagerOrAdmin,
} from "./auth";
import { createXlsx, XLSX_CONTENT_TYPE } from "../xlsx";

type JsonObject = Record<string, unknown>;

interface InventoryItemRow {
  id: number;
  ingredient_id: number | null;
  name: string;
  category: string | null;
  sku: string | null;
  base_unit: string;
  purchase_unit: string | null;
  purchase_to_base: number;
  default_location_id: number | null;
  cost_cents: number;
  shelf_life_days: number | null;
  active: number;
  created_at: string;
  updated_at: string;
}

interface InventoryLocationRow {
  id: number;
  name: string;
  description: string | null;
  active: number;
}

interface VendorRow {
  id: number;
  name: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  lead_time_days: number;
  active: number;
  created_at: string;
  updated_at: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(value: string | null): string | null {
  return value === null || value.includes("T") ? value : value.replace(" ", "T");
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function booleanValue(value: unknown, fallback = true): boolean {
  return typeof value === "boolean" ? value : value === undefined ? fallback : Boolean(value);
}

async function jsonBody(request: Request): Promise<JsonObject | Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return validationError(request, [{
      type: "json_invalid",
      loc: ["body", 0],
      msg: "JSON decode error",
      input: {},
      ctx: { error: "Invalid JSON" },
    }]);
  }
  return isObject(value)
    ? value
    : validationError(request, [{
      type: "model_attributes_type",
      loc: ["body"],
      msg: "Input should be a valid dictionary or object",
      input: value,
    }]);
}

function requiredString(
  request: Request,
  body: JsonObject,
  field: string,
  maxLength: number,
): string | Response {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    return validationError(request, [{
      type: value === undefined ? "missing" : "string_too_short",
      loc: ["body", field],
      msg: value === undefined ? "Field required" : "String should have at least 1 character",
      input: value ?? body,
      ctx: value === undefined ? undefined : { min_length: 1 },
    }]);
  }
  if (value.length > maxLength) {
    return validationError(request, [{
      type: "string_too_long",
      loc: ["body", field],
      msg: `String should have at most ${maxLength} characters`,
      input: value,
      ctx: { max_length: maxLength },
    }]);
  }
  return value.trim();
}

function serializeItem(row: InventoryItemRow): JsonObject {
  return {
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    name: row.name,
    category: row.category,
    sku: row.sku,
    base_unit: row.base_unit,
    purchase_unit: row.purchase_unit,
    purchase_to_base: row.purchase_to_base,
    default_location_id: row.default_location_id,
    cost_cents: row.cost_cents,
    shelf_life_days: row.shelf_life_days,
    active: Boolean(row.active),
    id: row.id,
    ingredient_id: row.ingredient_id,
  };
}

function serializeLocation(row: InventoryLocationRow): JsonObject {
  return {
    name: row.name,
    description: row.description,
    active: Boolean(row.active),
    id: row.id,
  };
}

function serializeVendor(row: VendorRow): JsonObject {
  return {
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
    name: row.name,
    contact_name: row.contact_name,
    email: row.email,
    phone: row.phone,
    lead_time_days: row.lead_time_days,
    active: Boolean(row.active),
    id: row.id,
  };
}

async function requireUser(request: Request, bindings: RuntimeBindings) {
  return authenticateRequest(request, bindings);
}

async function requireManager(request: Request, bindings: RuntimeBindings) {
  const authentication = await authenticateRequest(request, bindings);
  if (authentication.response !== null || authentication.user === null) return authentication;
  const denied = requireManagerOrAdmin(request, authentication.user.role);
  return denied === null
    ? authentication
    : { user: null, response: denied };
}

async function listLocations(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null) return auth.response;
  const result = await bindings.database.prepare(
    `SELECT id, name, description, active
     FROM inventory_locations WHERE active = 1 ORDER BY name`,
  ).all<InventoryLocationRow>();
  return jsonResponse(request, result.results.map(serializeLocation));
}

async function createLocation(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null) return auth.response;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const name = requiredString(request, body, "name", 100);
  if (name instanceof Response) return name;
  try {
    const row = await bindings.database.prepare(
      `INSERT INTO inventory_locations
       (name, description, active, created_at, updated_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, name, description, active`,
    ).bind(name, typeof body.description === "string" ? body.description : null,
      booleanValue(body.active) ? 1 : 0).first<InventoryLocationRow>();
    if (row === null) throw new Error("Location insert returned no row");
    return jsonResponse(request, serializeLocation(row), { status: 201 });
  } catch (error) {
    if (error instanceof Error && /unique|constraint/iu.test(error.message)) {
      return apiError(request, 400, "Inventory location already exists");
    }
    throw error;
  }
}

async function listItems(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null) return auth.response;
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (url.searchParams.has("active")) {
    clauses.push("active = ?");
    values.push(url.searchParams.get("active")?.toLowerCase() === "true" ? 1 : 0);
  }
  const search = url.searchParams.get("search")?.trim();
  if (search) {
    clauses.push("LOWER(name) LIKE LOWER(?)");
    values.push(`%${search}%`);
  }
  const category = url.searchParams.get("category")?.trim();
  if (category) {
    clauses.push("category = ?");
    values.push(category);
  }
  const query = `SELECT id, ingredient_id, name, category, sku, base_unit,
    purchase_unit, purchase_to_base, default_location_id, cost_cents,
    shelf_life_days, active, created_at, updated_at
    FROM inventory_items ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    ORDER BY category, name`;
  const result = await bindings.database.prepare(query).bind(...values).all<InventoryItemRow>();
  return jsonResponse(request, result.results.map(serializeItem));
}

function itemValues(body: JsonObject): {
  category: string | null;
  sku: string | null;
  baseUnit: string;
  purchaseUnit: string | null;
  purchaseToBase: number;
  defaultLocationId: number | null;
  costCents: number;
  shelfLifeDays: number | null;
  active: number;
} {
  return {
    category: typeof body.category === "string" && body.category.length ? body.category : null,
    sku: typeof body.sku === "string" && body.sku.length ? body.sku : null,
    baseUnit: typeof body.base_unit === "string" && body.base_unit.length ? body.base_unit : "unit",
    purchaseUnit: typeof body.purchase_unit === "string" && body.purchase_unit.length
      ? body.purchase_unit : null,
    purchaseToBase: numberValue(body.purchase_to_base, 1),
    defaultLocationId: body.default_location_id === null || body.default_location_id === undefined
      ? null : numberValue(body.default_location_id),
    costCents: Math.max(0, Math.trunc(numberValue(body.cost_cents))),
    shelfLifeDays: body.shelf_life_days === null || body.shelf_life_days === undefined
      ? null : Math.max(0, Math.trunc(numberValue(body.shelf_life_days))),
    active: booleanValue(body.active) ? 1 : 0,
  };
}

async function ensureLocation(database: D1Database, id: number | null): Promise<boolean> {
  if (id === null) return true;
  return (await database.prepare("SELECT id FROM inventory_locations WHERE id = ?")
    .bind(id).first()) !== null;
}

async function createItem(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null) return auth.response;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const name = requiredString(request, body, "name", 150);
  if (name instanceof Response) return name;
  const values = itemValues(body);
  if (values.purchaseToBase <= 0) return apiError(request, 422, "purchase_to_base must be greater than 0");
  if (!(await ensureLocation(bindings.database, values.defaultLocationId))) {
    return apiError(request, 404, "Inventory location not found");
  }
  try {
    const row = await bindings.database.prepare(
      `INSERT INTO inventory_items
       (ingredient_id, name, category, sku, base_unit, purchase_unit,
        purchase_to_base, default_location_id, cost_cents, shelf_life_days,
        active, created_at, updated_at)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, ingredient_id, name, category, sku, base_unit, purchase_unit,
         purchase_to_base, default_location_id, cost_cents, shelf_life_days,
         active, created_at, updated_at`,
    ).bind(name, values.category, values.sku, values.baseUnit, values.purchaseUnit,
      values.purchaseToBase, values.defaultLocationId, values.costCents,
      values.shelfLifeDays, values.active).first<InventoryItemRow>();
    if (row === null) throw new Error("Item insert returned no row");
    return jsonResponse(request, serializeItem(row), { status: 201 });
  } catch (error) {
    if (error instanceof Error && /unique|constraint/iu.test(error.message)) {
      return apiError(request, 400, "Inventory item SKU already exists");
    }
    throw error;
  }
}

async function activateCatalogItem(request:Request,bindings:RuntimeBindings):Promise<Response>{
  const auth=await requireManager(request,bindings);if(auth.response!==null)return auth.response;const body=await jsonBody(request);if(body instanceof Response)return body;const externalId=typeof body.catalog_id==="string"?body.catalog_id:"";
  const ingredient=await bindings.database.prepare("SELECT id,name,category FROM ingredients WHERE external_id=? AND active=1").bind(externalId).first<{id:number;name:string;category:string|null}>();if(!ingredient)return apiError(request,404,"Catalog ingredient not found");
  const existing=await bindings.database.prepare("SELECT id FROM inventory_items WHERE ingredient_id=?").bind(ingredient.id).first<{id:number}>();const itemId=existing?.id??randomId();
  if(existing)await bindings.database.prepare(`UPDATE inventory_items SET active=1,sku=?,base_unit=?,purchase_unit=?,purchase_to_base=?,default_location_id=?,cost_cents=?,shelf_life_days=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(body.sku??null,body.base_unit??"each",body.purchase_unit??null,numberValue(body.purchase_to_base,1),body.default_location_id??null,numberValue(body.cost_cents),body.shelf_life_days??null,itemId).run();
  else await bindings.database.prepare(`INSERT INTO inventory_items(id,ingredient_id,name,category,sku,base_unit,purchase_unit,purchase_to_base,default_location_id,cost_cents,shelf_life_days,active,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(itemId,ingredient.id,ingredient.name,ingredient.category,body.sku??null,body.base_unit??"each",body.purchase_unit??null,numberValue(body.purchase_to_base,1),body.default_location_id??null,numberValue(body.cost_cents),body.shelf_life_days??null).run();
  const row=await bindings.database.prepare("SELECT * FROM inventory_items WHERE id=?").bind(itemId).first<InventoryItemRow>();return jsonResponse(request,serializeItem(row!),{status:201});
}

async function updateItem(
  request: Request,
  itemId: number,
  bindings: RuntimeBindings,
): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null) return auth.response;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const name = requiredString(request, body, "name", 150);
  if (name instanceof Response) return name;
  const values = itemValues(body);
  if (!(await ensureLocation(bindings.database, values.defaultLocationId))) {
    return apiError(request, 404, "Inventory location not found");
  }
  const row = await bindings.database.prepare(
    `UPDATE inventory_items SET name = ?, category = ?, sku = ?, base_unit = ?,
       purchase_unit = ?, purchase_to_base = ?, default_location_id = ?,
       cost_cents = ?, shelf_life_days = ?, active = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
     RETURNING id, ingredient_id, name, category, sku, base_unit, purchase_unit,
       purchase_to_base, default_location_id, cost_cents, shelf_life_days,
       active, created_at, updated_at`,
  ).bind(name, values.category, values.sku, values.baseUnit, values.purchaseUnit,
    values.purchaseToBase, values.defaultLocationId, values.costCents,
    values.shelfLifeDays, values.active, itemId).first<InventoryItemRow>();
  return row === null
    ? apiError(request, 404, "Inventory item not found")
    : jsonResponse(request, serializeItem(row));
}

async function listBalances(
  request: Request,
  itemId: number,
  bindings: RuntimeBindings,
): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null) return auth.response;
  const item = await bindings.database.prepare("SELECT id FROM inventory_items WHERE id = ?")
    .bind(itemId).first();
  if (item === null) return apiError(request, 404, "Inventory item not found");
  const result = await bindings.database.prepare(
    `SELECT id, inventory_item_id, location_id, quantity_on_hand,
            minimum_quantity, par_quantity, maximum_quantity
     FROM inventory_balances WHERE inventory_item_id = ? ORDER BY location_id`,
  ).bind(itemId).all();
  return jsonResponse(request, result.results);
}

async function upsertBalance(
  request: Request,
  itemId: number,
  bindings: RuntimeBindings,
): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null) return auth.response;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const locationId = numberValue(body.location_id);
  if (locationId <= 0) return apiError(request, 422, "location_id is required");
  const [item, location] = await Promise.all([
    bindings.database.prepare("SELECT id FROM inventory_items WHERE id = ?").bind(itemId).first(),
    bindings.database.prepare("SELECT id FROM inventory_locations WHERE id = ?").bind(locationId).first(),
  ]);
  if (item === null) return apiError(request, 404, "Inventory item not found");
  if (location === null) return apiError(request, 404, "Inventory location not found");
  const row = await bindings.database.prepare(
    `INSERT INTO inventory_balances
      (inventory_item_id, location_id, quantity_on_hand, minimum_quantity,
       par_quantity, maximum_quantity, planning_active, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(inventory_item_id, location_id) DO UPDATE SET
       minimum_quantity = excluded.minimum_quantity,
       par_quantity = excluded.par_quantity,
       maximum_quantity = excluded.maximum_quantity,
       updated_at = CURRENT_TIMESTAMP
     RETURNING id, inventory_item_id, location_id, quantity_on_hand,
       minimum_quantity, par_quantity, maximum_quantity`,
  ).bind(itemId, locationId, Math.max(0, numberValue(body.minimum_quantity)),
    Math.max(0, numberValue(body.par_quantity)),
    body.maximum_quantity === null || body.maximum_quantity === undefined
      ? null : Math.max(0, numberValue(body.maximum_quantity))).first();
  return jsonResponse(request, row);
}

async function listVendors(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null) return auth.response;
  const result = await bindings.database.prepare(
    `SELECT id, name, contact_name, email, phone, lead_time_days,
            active, created_at, updated_at
     FROM inventory_vendors WHERE active = 1 ORDER BY name`,
  ).all<VendorRow>();
  return jsonResponse(request, result.results.map(serializeVendor));
}

async function createVendor(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null) return auth.response;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const name = requiredString(request, body, "name", 150);
  if (name instanceof Response) return name;
  try {
    const row = await bindings.database.prepare(
      `INSERT INTO inventory_vendors
       (name, contact_name, email, phone, lead_time_days, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING id, name, contact_name, email, phone, lead_time_days,
         active, created_at, updated_at`,
    ).bind(name, typeof body.contact_name === "string" ? body.contact_name : null,
      typeof body.email === "string" ? body.email : null,
      typeof body.phone === "string" ? body.phone : null,
      Math.max(0, Math.trunc(numberValue(body.lead_time_days, 1))),
      booleanValue(body.active) ? 1 : 0).first<VendorRow>();
    if (row === null) throw new Error("Vendor insert returned no row");
    return jsonResponse(request, serializeVendor(row), { status: 201 });
  } catch (error) {
    if (error instanceof Error && /unique|constraint/iu.test(error.message)) {
      return apiError(request, 400, "Vendor already exists");
    }
    throw error;
  }
}

async function createVendorItem(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null) return auth.response;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const vendorId = numberValue(body.vendor_id);
  const itemId = numberValue(body.inventory_item_id);
  const [vendor, item] = await Promise.all([
    bindings.database.prepare("SELECT id FROM inventory_vendors WHERE id = ?").bind(vendorId).first(),
    bindings.database.prepare("SELECT id FROM inventory_items WHERE id = ?").bind(itemId).first(),
  ]);
  if (vendor === null) return apiError(request, 404, "Vendor not found");
  if (item === null) return apiError(request, 404, "Inventory item not found");
  try {
    const row = await bindings.database.prepare(
      `INSERT INTO inventory_vendor_items
       (vendor_id, inventory_item_id, vendor_sku, unit_price_cents,
        pack_quantity, preferred, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       RETURNING *`,
    ).bind(vendorId, itemId, typeof body.vendor_sku === "string" ? body.vendor_sku : null,
      Math.max(0, Math.trunc(numberValue(body.unit_price_cents))),
      Math.max(0.0001, numberValue(body.pack_quantity, 1)),
      booleanValue(body.preferred, false) ? 1 : 0).first<Record<string, unknown>>();
    if (row === null) throw new Error("Vendor item insert returned no row");
    return jsonResponse(request, { ...row, preferred: Boolean(row.preferred), created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)) }, { status: 201 });
  } catch (error) {
    if (error instanceof Error && /unique|constraint/iu.test(error.message)) {
      return apiError(request, 400, "Vendor item already exists");
    }
    throw error;
  }
}

async function stock(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null) return auth.response;
  const locationId = url.searchParams.get("location_id");
  const statusFilter = url.searchParams.get("status")?.toUpperCase();
  const sql = `SELECT i.id AS inventory_item_id, i.name AS item_name,
    i.category, l.id AS location_id, l.name AS location_name, i.base_unit,
    b.quantity_on_hand, b.minimum_quantity, b.par_quantity
    FROM inventory_balances b
    JOIN inventory_items i ON i.id = b.inventory_item_id
    JOIN inventory_locations l ON l.id = b.location_id
    WHERE i.active = 1 AND l.active = 1 ${locationId ? "AND l.id = ?" : ""}
    ORDER BY i.category, i.name`;
  const result = await bindings.database.prepare(sql)
    .bind(...(locationId ? [Number(locationId)] : [])).all<Record<string, unknown>>();
  const rows = result.results.map((row) => {
    const onHand = numberValue(row.quantity_on_hand);
    const minimum = numberValue(row.minimum_quantity);
    const status = onHand <= 0 ? "OUT" : onHand <= minimum ? "LOW" : "HEALTHY";
    return { ...row, status, earliest_expiration: null };
  }).filter((row) => !statusFilter || row.status === statusFilter);
  return jsonResponse(request, rows);
}

async function dashboard(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null) return auth.response;
  const [items, locations, balances, pendingOrders, recentMovements, counts, countLines] = await bindings.database.batch([
    bindings.database.prepare("SELECT id, category, cost_cents FROM inventory_items WHERE active = 1"),
    bindings.database.prepare("SELECT id, name FROM inventory_locations WHERE active = 1 ORDER BY name"),
    bindings.database.prepare(`SELECT b.*, i.name AS item_name, i.category, i.base_unit,
      i.cost_cents, l.name AS location_name FROM inventory_balances b
      JOIN inventory_items i ON i.id = b.inventory_item_id
      JOIN inventory_locations l ON l.id = b.location_id
      WHERE i.active = 1 AND l.active = 1`),
    bindings.database.prepare("SELECT COUNT(*) AS total FROM inventory_purchase_orders WHERE status IN ('DRAFT','SUBMITTED','PARTIALLY_RECEIVED')"),
    bindings.database.prepare("SELECT COUNT(*) AS total FROM (SELECT id FROM stock_movements WHERE inventory_item_id IS NOT NULL ORDER BY created_at DESC LIMIT 10)"),
    bindings.database.prepare(`SELECT id, location_id, status, updated_at
      FROM inventory_counts WHERE status != 'REJECTED'
      ORDER BY created_at DESC, id DESC`),
    bindings.database.prepare(`SELECT cl.count_id, cl.inventory_item_id, cl.counted_quantity,
      cl.expected_quantity, cl.is_counted, cl.source, cl.review_status,
      i.name AS item_name, i.category, i.base_unit, i.cost_cents,
      c.location_id, l.name AS location_name, c.updated_at
      FROM inventory_count_lines cl
      JOIN inventory_counts c ON c.id = cl.count_id
      JOIN inventory_items i ON i.id = cl.inventory_item_id
      JOIN inventory_locations l ON l.id = c.location_id
      WHERE c.status != 'REJECTED'`),
  ]);
  const itemRows = items.results as Array<Record<string, unknown>>;
  const locationRows = locations.results as Array<Record<string, unknown>>;
  const balanceRows = balances.results as Array<Record<string, unknown>>;
  const category = new Map<string, { value_cents: number; ids: Set<number> }>();
  const low: JsonObject[] = [];
  let value = 0;
  let orderCost = 0;
  let out = 0;
  for (const row of balanceRows) {
    const onHand = numberValue(row.quantity_on_hand);
    const minimum = numberValue(row.minimum_quantity);
    const par = numberValue(row.par_quantity);
    const cost = numberValue(row.cost_cents);
    const rowValue = Math.round(Math.max(0, onHand) * cost);
    const rowOrder = Math.round(Math.max(0, par - onHand) * cost);
    value += rowValue;
    orderCost += rowOrder;
    const categoryName = typeof row.category === "string" ? row.category : "Uncategorized";
    const categoryRow = category.get(categoryName) ?? { value_cents: 0, ids: new Set<number>() };
    categoryRow.value_cents += rowValue;
    categoryRow.ids.add(numberValue(row.inventory_item_id));
    category.set(categoryName, categoryRow);
    const hasTarget = minimum > 0 || par > 0;
    const status = hasTarget && onHand <= 0 ? "OUT" : hasTarget && onHand <= minimum ? "LOW" : "HEALTHY";
    if (status === "OUT") out += 1;
    if (status !== "HEALTHY") low.push({
      inventory_item_id: row.inventory_item_id,
      item_name: row.item_name,
      category: row.category,
      location_id: row.location_id,
      location_name: row.location_name,
      base_unit: row.base_unit,
      quantity_on_hand: onHand,
      minimum_quantity: minimum,
      par_quantity: par,
      order_quantity: Math.max(0, par - onHand),
      unit_cost_cents: cost,
      estimated_cost_cents: rowOrder,
      status,
    });
  }
  const categoryValues = [...category.entries()].filter(([, row]) => row.value_cents > 0)
    .map(([name, row]) => ({ category: name, value_cents: row.value_cents,
      item_count: row.ids.size, percent: value ? Math.round(row.value_cents / value * 1000) / 10 : 0 }))
    .sort((a, b) => b.value_cents - a.value_cents || a.category.localeCompare(b.category));
  low.sort((a, b) => String(a.status).localeCompare(String(b.status)) || numberValue(b.estimated_cost_cents) - numberValue(a.estimated_cost_cents));
  const balanceCounts = new Map<number, number>();
  for (const row of balanceRows) balanceCounts.set(numberValue(row.location_id), (balanceCounts.get(numberValue(row.location_id)) ?? 0) + 1);
  const latestByLocation = new Map<number, number>();
  const openByLocation = new Map<number, number>();
  const countById = new Map<number, Record<string, unknown>>();
  let openCountSessions = 0;
  let lastCountAt: string | null = null;
  for (const row of counts.results as Array<Record<string, unknown>>) {
    const id = numberValue(row.id);
    const locationId = numberValue(row.location_id);
    countById.set(id, row);
    if (!latestByLocation.has(locationId)) latestByLocation.set(locationId, id);
    if (["DRAFT", "SUBMITTED"].includes(String(row.status))) {
      openCountSessions += 1;
      if (!openByLocation.has(locationId)) openByLocation.set(locationId, id);
    }
    if (row.status === "POSTED" && (lastCountAt === null || String(row.updated_at) > lastCountAt)) {
      lastCountAt = String(row.updated_at);
    }
  }
  const linesByCount = new Map<number, Array<Record<string, unknown>>>();
  for (const row of countLines.results as Array<Record<string, unknown>>) {
    const countId = numberValue(row.count_id);
    linesByCount.set(countId, [...(linesByCount.get(countId) ?? []), row]);
  }
  let uncountedItemCount = 0;
  let countsRequiringReview = 0;
  const countCompletion = locationRows.map((location) => {
    const locationId = numberValue(location.id);
    const countId = openByLocation.get(locationId) ?? null;
    const count = countId === null ? null : countById.get(countId) ?? null;
    const lines = countId === null ? [] : linesByCount.get(countId) ?? [];
    const totalLines = count === null ? balanceCounts.get(locationId) ?? 0 : lines.length;
    const countedLines = count === null ? 0 : lines.filter((line) => Boolean(line.is_counted)).length;
    const exceptionCount = count === null ? 0 : lines.filter((line) => line.review_status === "NEEDS_REVIEW").length;
    if (count !== null) {
      uncountedItemCount += totalLines - countedLines;
      countsRequiringReview += exceptionCount;
    }
    return {
      location_id: location.id,
      location_name: location.name,
      count_id: countId,
      status: count?.status ?? "NOT_STARTED",
      total_lines: totalLines,
      counted_lines: countedLines,
      uncounted_lines: totalLines - countedLines,
      exception_count: exceptionCount,
      completion_percent: totalLines ? Math.round(countedLines / totalLines * 1000) / 10 : 0,
      updated_at: count === null ? null : iso(String(count.updated_at)),
    };
  }).sort((a, b) => Number(a.status === "NOT_STARTED") - Number(b.status === "NOT_STARTED")
    || a.completion_percent - b.completion_percent || String(a.location_name).localeCompare(String(b.location_name)));
  let signedVarianceValueCents = 0;
  let absoluteVarianceValueCents = 0;
  const largestVariances: JsonObject[] = [];
  for (const [locationId, countId] of latestByLocation) {
    for (const line of linesByCount.get(countId) ?? []) {
      if (!Boolean(line.is_counted)) continue;
      const expected = numberValue(line.expected_quantity);
      const counted = numberValue(line.counted_quantity);
      const variance = counted - expected;
      const varianceValue = Math.round(variance * numberValue(line.cost_cents));
      signedVarianceValueCents += varianceValue;
      absoluteVarianceValueCents += Math.abs(varianceValue);
      if (variance === 0) continue;
      largestVariances.push({
        count_id: countId,
        inventory_item_id: line.inventory_item_id,
        item_name: line.item_name,
        category: line.category,
        location_id: locationId,
        location_name: line.location_name,
        base_unit: line.base_unit,
        expected_quantity: expected,
        counted_quantity: counted,
        variance_quantity: variance,
        variance_value_cents: varianceValue,
        absolute_variance_value_cents: Math.abs(varianceValue),
        source: line.source,
        review_status: line.review_status,
        updated_at: iso(String(line.updated_at)),
      });
    }
  }
  largestVariances.sort((a, b) => numberValue(b.absolute_variance_value_cents) - numberValue(a.absolute_variance_value_cents)
    || String(a.item_name).localeCompare(String(b.item_name)));
  return jsonResponse(request, {
    item_count: itemRows.length,
    missing_cost_item_count: itemRows.filter((row) => numberValue(row.cost_cents) <= 0).length,
    location_count: locationRows.length,
    low_stock_count: low.length,
    out_of_stock_count: out,
    open_count_sessions: openCountSessions,
    pending_purchase_orders: numberValue((pendingOrders.results[0] as Record<string, unknown> | undefined)?.total),
    recent_movements: numberValue((recentMovements.results[0] as Record<string, unknown> | undefined)?.total),
    total_inventory_value_cents: value,
    estimated_order_cost_cents: orderCost,
    signed_variance_value_cents: signedVarianceValueCents,
    absolute_variance_value_cents: absoluteVarianceValueCents,
    uncounted_item_count: uncountedItemCount,
    counts_requiring_review: countsRequiringReview,
    last_count_at: lastCountAt === null ? null : iso(lastCountAt),
    category_values: categoryValues,
    count_completion: countCompletion,
    low_stock_items: low.slice(0, 25),
    largest_variances: largestVariances.slice(0, 15),
  });
}

async function listMovements(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null) return auth.response;
  const limit = Math.min(500, Math.max(1, numberValue(url.searchParams.get("limit"), 100)));
  const result = await bindings.database.prepare(
    `SELECT id, inventory_item_id, location_id, quantity_change, reason, notes,
      source_event_key, lot_number, expiration_date, created_by_user_id,
      created_at, updated_at
     FROM stock_movements WHERE inventory_item_id IS NOT NULL
     ORDER BY created_at DESC, id DESC LIMIT ?`,
  ).bind(limit).all<Record<string, unknown>>();
  return jsonResponse(request, result.results.map((row) => ({
    ...row,
    created_at: iso(String(row.created_at)),
    updated_at: iso(String(row.updated_at)),
  })));
}

async function postMovement(
  request: Request,
  bindings: RuntimeBindings,
  reasonOverride?: string,
): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null || auth.user === null) return auth.response ?? apiError(request, 401, "Could not validate credentials");
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const itemId = numberValue(body.inventory_item_id);
  const locationId = numberValue(body.location_id);
  const quantity = numberValue(body.quantity_change);
  const reason = reasonOverride ?? (typeof body.reason === "string" ? body.reason.trim() : "");
  if (!itemId || !locationId || !reason) return apiError(request, 422, "inventory_item_id, location_id, and reason are required");
  const sourceKey = typeof body.source_event_key === "string" && body.source_event_key ? body.source_event_key : null;
  if (sourceKey) {
    const existing = await bindings.database.prepare(
      `SELECT id, inventory_item_id, location_id, quantity_change, reason, notes,
       source_event_key, lot_number, expiration_date, created_by_user_id,
       created_at, updated_at FROM stock_movements WHERE source_event_key = ?`,
    ).bind(sourceKey).first<Record<string, unknown>>();
    if (existing !== null) return jsonResponse(request, existing, { status: 201 });
  }
  const item = await bindings.database.prepare("SELECT id, ingredient_id, name, base_unit FROM inventory_items WHERE id = ?")
    .bind(itemId).first<Record<string, unknown>>();
  if (item === null) return apiError(request, 404, "Inventory item not found");
  if (!(await ensureLocation(bindings.database, locationId))) return apiError(request, 404, "Inventory location not found");
  let ingredientId = item.ingredient_id === null ? null : numberValue(item.ingredient_id);
  if (ingredientId === null) {
    const externalId = `inventory-item-${itemId}`;
    const existingIngredient = await bindings.database.prepare("SELECT id FROM ingredients WHERE external_id = ?")
      .bind(externalId).first<{ id: number }>();
    if (existingIngredient !== null) ingredientId = existingIngredient.id;
    else {
      const ingredient = await bindings.database.prepare(
        `INSERT INTO ingredients (external_id, name, normalized_name, unit, stage,
         added_to_complete_lineage, active)
         VALUES (?, ?, ?, ?, 'raw_material', 0, 1)
         RETURNING id`,
      ).bind(externalId, item.name, String(item.name).toLowerCase(), item.base_unit)
        .first<{ id: number }>();
      ingredientId = ingredient?.id ?? null;
    }
  }
  if (ingredientId === null) throw new Error("Could not create stock movement ingredient");
  const statements = [
    bindings.database.prepare("UPDATE inventory_items SET ingredient_id = COALESCE(ingredient_id, ?) WHERE id = ?")
      .bind(ingredientId, itemId),
    bindings.database.prepare(
      `INSERT INTO inventory_balances
       (inventory_item_id, location_id, quantity_on_hand, minimum_quantity,
        par_quantity, maximum_quantity, planning_active, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(inventory_item_id, location_id) DO UPDATE SET
         quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand,
         updated_at = CURRENT_TIMESTAMP`,
    ).bind(itemId, locationId, quantity),
    bindings.database.prepare(
      `INSERT INTO stock_movements
       (ingredient_id, inventory_item_id, location_id, quantity_change, reason,
        source_event_key, created_by_user_id, lot_number, expiration_date, notes,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(ingredientId, itemId, locationId, quantity, reason, sourceKey, auth.user.id,
      typeof body.lot_number === "string" ? body.lot_number : null,
      typeof body.expiration_date === "string" ? body.expiration_date : null,
      typeof body.notes === "string" ? body.notes : null),
  ];
  await bindings.database.batch(statements);
  const row = await bindings.database.prepare(
    `SELECT id, inventory_item_id, location_id, quantity_change, reason, notes,
      source_event_key, lot_number, expiration_date, created_by_user_id,
      created_at, updated_at FROM stock_movements
     WHERE inventory_item_id = ? AND location_id = ? ORDER BY id DESC LIMIT 1`,
  ).bind(itemId, locationId).first<Record<string, unknown>>();
  return jsonResponse(request, row, { status: 201 });
}

async function emptyList(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  return auth.response ?? jsonResponse(request, []);
}

function randomId(): number {
  const values = crypto.getRandomValues(new Uint32Array(1));
  return (values[0] & 0x7fffffff) || 1;
}

async function serializeCount(database: D1Database, countId: number): Promise<JsonObject | null> {
  const count = await database.prepare(
    `SELECT c.id,c.location_id,l.name AS location_name,c.template_id,t.name AS template_name,c.status,c.revision,
      c.counted_by_user_id,c.reviewed_by_user_id,c.notes,c.approved_at,c.created_at,c.updated_at
      FROM inventory_counts c JOIN inventory_locations l ON l.id=c.location_id
      LEFT JOIN inventory_count_templates t ON t.id=c.template_id WHERE c.id = ?`,
  ).bind(countId).first<Record<string, unknown>>();
  if (count === null) return null;
  const lines = await database.prepare(
    `SELECT cl.id,cl.inventory_item_id,i.name AS item_name,i.category,i.base_unit,cl.counted_quantity,cl.expected_quantity,
      (SELECT par_quantity FROM inventory_balances WHERE inventory_item_id=cl.inventory_item_id AND location_id=(SELECT location_id FROM inventory_counts WHERE id=cl.count_id)) AS par_quantity,cl.notes,
      cl.display_order,cl.is_counted,cl.source,cl.confidence,cl.review_status,cl.evidence,cl.revision
      FROM inventory_count_lines cl JOIN inventory_items i ON i.id=cl.inventory_item_id
      WHERE cl.count_id = ? ORDER BY cl.display_order, cl.id`,
  ).bind(countId).all<Record<string, unknown>>();
  const serializedLines: JsonObject[] = lines.results.map((line) => ({ ...line, is_counted: Boolean(line.is_counted),
    delta: line.expected_quantity === null ? null : numberValue(line.counted_quantity)-numberValue(line.expected_quantity),
    variance_quantity: line.expected_quantity === null ? null : numberValue(line.counted_quantity)-numberValue(line.expected_quantity),
    variance_percent: line.expected_quantity === null || numberValue(line.expected_quantity) === 0 ? null : ((numberValue(line.counted_quantity)-numberValue(line.expected_quantity))/numberValue(line.expected_quantity))*100 }));
  const counted = serializedLines.filter((line) => line.is_counted).length;
  const exceptions = serializedLines.filter((line) => line.review_status === "NEEDS_REVIEW").length;
  return { ...count, created_at: iso(count.created_at as string | null),updated_at:iso(count.updated_at as string | null),approved_at:iso(count.approved_at as string | null),
    lines: serializedLines,line_count:serializedLines.length,counted_line_count:counted,uncounted_line_count:serializedLines.length-counted,
    exception_count:exceptions,completion_percent:serializedLines.length===0?0:Math.round((counted/serializedLines.length)*10000)/100 };
}

async function listCounts(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null) return auth.response;
  const ids = await bindings.database.prepare(
    "SELECT id FROM inventory_counts ORDER BY created_at DESC, id DESC",
  ).all<{ id: number }>();
  const rows = await Promise.all(ids.results.map((row) => serializeCount(bindings.database, row.id)));
  return jsonResponse(request, rows.filter((row) => row !== null));
}

async function serializeTemplate(database: D1Database, templateId: number): Promise<JsonObject | null> {
  const template=await database.prepare("SELECT id,name,description,active,created_by_user_id FROM inventory_count_templates WHERE id=?").bind(templateId).first<JsonObject>();
  if(template===null)return null;
  const lines=await database.prepare(`SELECT tl.id,tl.inventory_item_id,i.name AS item_name,tl.location_id,l.name AS location_name,tl.display_order,tl.preferred_unit
    FROM inventory_count_template_lines tl JOIN inventory_items i ON i.id=tl.inventory_item_id JOIN inventory_locations l ON l.id=tl.location_id
    WHERE tl.template_id=? ORDER BY tl.display_order,tl.id`).bind(templateId).all<JsonObject>();
  return {...template,active:Boolean(template.active),lines:lines.results};
}

async function countTemplates(request:Request,bindings:RuntimeBindings):Promise<Response>{
  const auth=request.method==="POST"?await requireManager(request,bindings):await requireUser(request,bindings);if(auth.response!==null)return auth.response;
  if(request.method==="GET"){
    const ids=await bindings.database.prepare("SELECT id FROM inventory_count_templates WHERE active=1 ORDER BY name").all<{id:number}>();
    return jsonResponse(request,(await Promise.all(ids.results.map(row=>serializeTemplate(bindings.database,row.id)))).filter(Boolean));
  }
  if(request.method!=="POST"||auth.user===null)return methodNotAllowed(request,"GET, POST");
  const body=await jsonBody(request);if(body instanceof Response)return body;const name=typeof body.name==="string"?body.name.trim():"";const lines=Array.isArray(body.lines)?body.lines.filter(isObject):[];
  if(!name||lines.length===0)return apiError(request,400,"Template name and lines are required");const templateId=randomId();
  const statements:D1PreparedStatement[]=[bindings.database.prepare(`INSERT INTO inventory_count_templates(id,name,description,active,created_by_user_id,created_at,updated_at)
    VALUES(?,?,?,1,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(templateId,name,body.description??null,auth.user.id)];
  lines.forEach((line,index)=>statements.push(bindings.database.prepare(`INSERT INTO inventory_count_template_lines(id,template_id,inventory_item_id,location_id,display_order,preferred_unit)
    VALUES(?,?,?,?,?,?)`).bind(randomId(),templateId,numberValue(line.inventory_item_id),numberValue(line.location_id),numberValue(line.display_order,index),line.preferred_unit??null)));
  try{await bindings.database.batch(statements)}catch(error){if(error instanceof Error&&/UNIQUE/iu.test(error.message))return apiError(request,409,"Count template name already exists");throw error}
  return jsonResponse(request,await serializeTemplate(bindings.database,templateId),{status:201});
}

async function createCountSheet(request:Request,bindings:RuntimeBindings):Promise<Response>{
  const auth=await requireUser(request,bindings);if(auth.response!==null||auth.user===null)return auth.response??apiError(request,401,"Could not validate credentials");
  const body=await jsonBody(request);if(body instanceof Response)return body;const locationId=numberValue(body.location_id);if(!(await ensureLocation(bindings.database,locationId)))return apiError(request,404,"Inventory location not found");
  if(body.resume_existing!==false){const existing=await bindings.database.prepare("SELECT id FROM inventory_counts WHERE location_id=? AND status='DRAFT' ORDER BY updated_at DESC LIMIT 1").bind(locationId).first<{id:number}>();if(existing)return jsonResponse(request,await serializeCount(bindings.database,existing.id),{status:201});}
  const countId=randomId(),templateId=body.template_id===null||body.template_id===undefined?null:numberValue(body.template_id);
  const itemRows=templateId===null
    ? await bindings.database.prepare("SELECT id AS inventory_item_id FROM inventory_items WHERE active=1 AND (default_location_id=? OR default_location_id IS NULL) ORDER BY category,name").bind(locationId).all<{inventory_item_id:number}>()
    : await bindings.database.prepare("SELECT inventory_item_id FROM inventory_count_template_lines WHERE template_id=? AND location_id=? ORDER BY display_order,id").bind(templateId,locationId).all<{inventory_item_id:number}>();
  const statements:D1PreparedStatement[]=[bindings.database.prepare(`INSERT INTO inventory_counts(id,location_id,template_id,status,counted_by_user_id,reviewed_by_user_id,notes,revision,approved_at,created_at,updated_at)
    VALUES(?,?,?,'DRAFT',?,NULL,?,1,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(countId,locationId,templateId,auth.user.id,body.notes??null)];
  itemRows.results.forEach((row,index)=>statements.push(bindings.database.prepare(`INSERT INTO inventory_count_lines(id,count_id,inventory_item_id,counted_quantity,expected_quantity,notes,display_order,is_counted,source,confidence,review_status,evidence,revision,updated_by_user_id)
    VALUES(?,?,?,0,(SELECT quantity_on_hand FROM inventory_balances WHERE inventory_item_id=? AND location_id=?),NULL,?,0,'MANUAL',NULL,'PENDING',NULL,1,?)`)
    .bind(randomId(),countId,row.inventory_item_id,row.inventory_item_id,locationId,index,auth.user?.id)));
  await bindings.database.batch(statements);return jsonResponse(request,await serializeCount(bindings.database,countId),{status:201});
}

async function listCountSheets(request:Request,url:URL,bindings:RuntimeBindings):Promise<Response>{
  const auth=await requireUser(request,bindings);if(auth.response!==null)return auth.response;const clauses:string[]=[];const values:unknown[]=[];
  if(url.searchParams.has("location_id")){clauses.push("location_id=?");values.push(numberValue(url.searchParams.get("location_id")))}if(url.searchParams.has("status")){clauses.push("status=?");values.push(url.searchParams.get("status"))}
  const limit=Math.min(100,Math.max(1,numberValue(url.searchParams.get("limit"),25)));const where=clauses.length?`WHERE ${clauses.join(" AND ")}`:"";
  const ids=await bindings.database.prepare(`SELECT id FROM inventory_counts ${where} ORDER BY updated_at DESC,id DESC LIMIT ?`).bind(...values,limit).all<{id:number}>();
  return jsonResponse(request,(await Promise.all(ids.results.map(row=>serializeCount(bindings.database,row.id)))).filter(Boolean));
}
async function readCountSheet(request:Request,countId:number,bindings:RuntimeBindings):Promise<Response>{const auth=await requireUser(request,bindings);if(auth.response!==null)return auth.response;const sheet=await serializeCount(bindings.database,countId);return sheet===null?apiError(request,404,"Inventory count not found"):jsonResponse(request,sheet)}

async function patchCountLines(request:Request,countId:number,bindings:RuntimeBindings):Promise<Response>{
  const auth=await requireUser(request,bindings);if(auth.response!==null||auth.user===null)return auth.response??apiError(request,401,"Could not validate credentials");
  const count=await bindings.database.prepare("SELECT status FROM inventory_counts WHERE id=?").bind(countId).first<{status:string}>();if(!count)return apiError(request,404,"Inventory count not found");if(count.status!=="DRAFT")return apiError(request,409,"Only draft count sheets can be edited");
  const body=await jsonBody(request);if(body instanceof Response)return body;const edits=Array.isArray(body.edits)?body.edits.filter(isObject):[];if(edits.length===0)return apiError(request,400,"At least one edit is required");
  const statements=edits.map(edit=>bindings.database.prepare(`UPDATE inventory_count_lines SET counted_quantity=COALESCE(?,counted_quantity),notes=COALESCE(?,notes),is_counted=COALESCE(?,is_counted),source=COALESCE(?,source),confidence=COALESCE(?,confidence),review_status=COALESCE(?,review_status),evidence=COALESCE(?,evidence),revision=revision+1,updated_by_user_id=? WHERE id=? AND count_id=?`)
    .bind(edit.counted_quantity??null,edit.notes??null,edit.is_counted===undefined?null:(edit.is_counted?1:0),edit.source??null,edit.confidence??null,edit.review_status??null,edit.evidence??null,auth.user?.id,numberValue(edit.line_id),countId));
  statements.push(bindings.database.prepare("UPDATE inventory_counts SET revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(countId));await bindings.database.batch(statements);
  return jsonResponse(request,await serializeCount(bindings.database,countId));
}

async function patchCountLine(request:Request,countId:number,lineId:number,bindings:RuntimeBindings):Promise<Response>{const payload=await jsonBody(request);if(payload instanceof Response)return payload;return patchCountLines(new Request(request.url,{method:"POST",headers:request.headers,body:JSON.stringify({edits:[{...payload,line_id:lineId}]})}),countId,bindings)}

async function approveCount(request:Request,countId:number,bindings:RuntimeBindings):Promise<Response>{
  const auth=await requireManager(request,bindings);if(auth.response!==null||auth.user===null)return auth.response??apiError(request,401,"Could not validate credentials");
  const summary=await bindings.database.prepare("SELECT c.status,SUM(CASE WHEN l.is_counted=0 THEN 1 ELSE 0 END) AS uncounted,SUM(CASE WHEN l.review_status='NEEDS_REVIEW' THEN 1 ELSE 0 END) AS exceptions FROM inventory_counts c LEFT JOIN inventory_count_lines l ON l.count_id=c.id WHERE c.id=? GROUP BY c.id").bind(countId).first<JsonObject>();
  if(!summary)return apiError(request,404,"Inventory count not found");if(summary.status!=="DRAFT"&&summary.status!=="SUBMITTED")return apiError(request,409,"Only draft or submitted count sheets can be approved");if(numberValue(summary.uncounted)||numberValue(summary.exceptions))return apiError(request,409,`Count sheet has ${numberValue(summary.uncounted)} uncounted row(s) and ${numberValue(summary.exceptions)} unresolved exception(s)`);
  await bindings.database.batch([bindings.database.prepare("UPDATE inventory_count_lines SET review_status='APPROVED' WHERE count_id=?").bind(countId),bindings.database.prepare("UPDATE inventory_counts SET status='APPROVED',reviewed_by_user_id=?,approved_at=CURRENT_TIMESTAMP,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(auth.user.id,countId)]);return jsonResponse(request,await serializeCount(bindings.database,countId));
}

async function reorderCount(request:Request,countId:number,bindings:RuntimeBindings):Promise<Response>{
  const auth=await requireUser(request,bindings);if(auth.response!==null)return auth.response;const body=await jsonBody(request);if(body instanceof Response)return body;const ids=Array.isArray(body.line_ids)?body.line_ids.map(numberValue):[];
  const existing=await bindings.database.prepare("SELECT id FROM inventory_count_lines WHERE count_id=? ORDER BY id").bind(countId).all<{id:number}>();if(ids.length!==existing.results.length||new Set(ids).size!==ids.length)return apiError(request,400,"line_ids must contain every count line exactly once");
  await bindings.database.batch(ids.map((lineId,index)=>bindings.database.prepare("UPDATE inventory_count_lines SET display_order=? WHERE id=? AND count_id=?").bind(index,lineId,countId)));return jsonResponse(request,await serializeCount(bindings.database,countId));
}

function csvCell(value:unknown):string{const text=value===null||value===undefined?"":String(value);return /[",\r\n]/u.test(text)?`"${text.replace(/"/gu,'""')}"`:text}
function html(value:unknown):string{return String(value??"").replace(/[&<>"']/gu,char=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]!)}
async function countExport(request:Request,countId:number,format:"csv"|"xlsx"|"print",bindings:RuntimeBindings):Promise<Response>{
  const auth=await requireUser(request,bindings);if(auth.response!==null)return auth.response;const sheet=await serializeCount(bindings.database,countId);if(!sheet)return apiError(request,404,"Inventory count not found");const lines=sheet.lines as JsonObject[];
  const headers=["Order","Item","Category","Unit","On Hand","Par","Count","Delta","Source","Approval","Notes"];const rows=lines.map(line=>[numberValue(line.display_order)+1,line.item_name,line.category??"",line.base_unit,line.expected_quantity,line.par_quantity,line.is_counted?line.counted_quantity:"",line.is_counted?line.delta:"",line.source??"",line.review_status,line.notes??""]);
  if(format==="csv"){const content=[headers,...rows].map(row=>row.map(csvCell).join(",")).join("\n")+"\n";return new Response(content,{headers:{"Content-Type":"text/csv; charset=utf-8","Content-Disposition":`attachment; filename="inventory-count-${countId}.csv"`}})}
  if(format==="xlsx"){const bytes=createXlsx([{name:"Inventory Count",title:`${String(sheet.location_name)} Inventory Count`,headers,rows,widths:[8,30,20,12,12,12,12,12,12,16,30],freeze:"E3",headerRow:2}]);return new Response(bytes,{headers:{"Content-Type":XLSX_CONTENT_TYPE,"Content-Disposition":`attachment; filename="inventory-count-${countId}.xlsx"`}})}
  const document=`<!doctype html><html><head><meta charset="utf-8"><title>Inventory Count ${countId}</title><style>body{font-family:Arial,sans-serif;margin:24px;color:#111}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:6px;text-align:left}th{background:#eee}@media print{button{display:none}}</style></head><body><button onclick="print()">Print</button><h1>Inventory Count #${countId}</h1><p>${html(sheet.location_name)} · ${html(sheet.status)} · ${html(sheet.updated_at)}</p><table><thead><tr><th>Item</th><th>Unit</th><th>Expected</th><th>Counted</th><th>Variance</th><th>Status</th><th>Notes</th></tr></thead><tbody>${lines.map(line=>`<tr><td>${html(line.item_name)}</td><td>${html(line.base_unit)}</td><td>${html(line.expected_quantity)}</td><td>${html(line.counted_quantity)}</td><td>${html(line.variance_quantity)}</td><td>${html(line.review_status)}</td><td>${html(line.notes)}</td></tr>`).join("")}</tbody></table></body></html>`;return new Response(document,{headers:{"Content-Type":"text/html; charset=utf-8"}});
}

async function createCount(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null || auth.user === null) return auth.response ?? apiError(request, 401, "Could not validate credentials");
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const locationId = numberValue(body.location_id);
  if (!(await ensureLocation(bindings.database, locationId))) return apiError(request, 404, "Inventory location not found");
  const inputLines = Array.isArray(body.lines) ? body.lines.filter(isObject) : [];
  const countId = randomId();
  const statements: D1PreparedStatement[] = [bindings.database.prepare(
    `INSERT INTO inventory_counts
     (id, location_id, template_id, status, counted_by_user_id,
      reviewed_by_user_id, notes, revision, approved_at, created_at, updated_at)
     VALUES (?, ?, NULL, 'DRAFT', ?, NULL, ?, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(countId, locationId, auth.user.id, typeof body.notes === "string" ? body.notes : null)];
  inputLines.forEach((line, index) => {
    statements.push(bindings.database.prepare(
      `INSERT INTO inventory_count_lines
       (id, count_id, inventory_item_id, counted_quantity, expected_quantity,
        notes, display_order, is_counted, source, confidence, review_status,
        evidence, revision, updated_by_user_id)
       VALUES (?, ?, ?, ?, (SELECT quantity_on_hand FROM inventory_balances
        WHERE inventory_item_id = ? AND location_id = ?), ?, ?, 1, 'MANUAL',
        NULL, 'READY', NULL, 1, ?)`,
    ).bind(randomId(), countId, numberValue(line.inventory_item_id),
      Math.max(0, numberValue(line.counted_quantity)), numberValue(line.inventory_item_id),
      locationId, typeof line.notes === "string" ? line.notes : null, index, auth.user?.id));
  });
  try {
    await bindings.database.batch(statements);
  } catch (error) {
    if (error instanceof Error && /foreign key|constraint/iu.test(error.message)) {
      return apiError(request, 404, "Inventory item not found");
    }
    throw error;
  }
  return jsonResponse(request, await serializeCount(bindings.database, countId), { status: 201 });
}

async function changeCountStatus(
  request: Request,
  countId: number,
  target: "SUBMITTED" | "POSTED",
  bindings: RuntimeBindings,
): Promise<Response> {
  const auth = target === "POSTED" ? await requireManager(request, bindings) : await requireUser(request, bindings);
  if (auth.response !== null || auth.user === null) return auth.response ?? apiError(request, 401, "Could not validate credentials");
  const count = await bindings.database.prepare("SELECT * FROM inventory_counts WHERE id = ?")
    .bind(countId).first<Record<string, unknown>>();
  if (count === null) return apiError(request, 404, "Inventory count not found");
  if (target === "SUBMITTED") {
    if (count.status !== "DRAFT") return apiError(request, 409, "Only draft counts can be submitted");
    const incomplete=await bindings.database.prepare("SELECT SUM(CASE WHEN is_counted=0 THEN 1 ELSE 0 END) AS uncounted,SUM(CASE WHEN review_status='NEEDS_REVIEW' THEN 1 ELSE 0 END) AS exceptions FROM inventory_count_lines WHERE count_id=?").bind(countId).first<JsonObject>();
    if(numberValue(incomplete?.uncounted)||numberValue(incomplete?.exceptions))return apiError(request,409,`Count sheet has ${numberValue(incomplete?.uncounted)} uncounted row(s) and ${numberValue(incomplete?.exceptions)} unresolved exception(s)`);
    await bindings.database.prepare(
      "UPDATE inventory_counts SET status = 'SUBMITTED', updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(countId).run();
    return jsonResponse(request, await serializeCount(bindings.database, countId));
  }
  if (count.status !== "SUBMITTED" && count.status !== "APPROVED") {
    return apiError(request, 409, "Only submitted or approved counts can be posted");
  }
  const lines = await bindings.database.prepare(
    `SELECT l.inventory_item_id, l.counted_quantity, i.ingredient_id, i.name, i.base_unit
     FROM inventory_count_lines l JOIN inventory_items i ON i.id = l.inventory_item_id
     WHERE l.count_id = ? AND l.is_counted = 1`,
  ).bind(countId).all<Record<string, unknown>>();
  const ingredientIds = new Map<number, number>();
  for (const line of lines.results) {
    const itemId = numberValue(line.inventory_item_id);
    let ingredientId = line.ingredient_id === null ? null : numberValue(line.ingredient_id);
    if (ingredientId === null) {
      const externalId = `inventory-item-${itemId}`;
      const existingIngredient = await bindings.database.prepare("SELECT id FROM ingredients WHERE external_id = ?")
        .bind(externalId).first<{ id: number }>();
      if (existingIngredient !== null) ingredientId = existingIngredient.id;
      else {
        const inserted = await bindings.database.prepare(
          `INSERT INTO ingredients (external_id, name, normalized_name, unit, stage,
            added_to_complete_lineage, active) VALUES (?, ?, ?, ?, 'raw_material', 0, 1)
           RETURNING id`,
        ).bind(externalId, line.name, String(line.name).toLowerCase(), line.base_unit)
          .first<{ id: number }>();
        ingredientId = inserted?.id ?? null;
      }
    }
    if (ingredientId !== null) ingredientIds.set(itemId, ingredientId);
  }
  const statements: D1PreparedStatement[] = [];
  for (const line of lines.results) {
    const itemId = numberValue(line.inventory_item_id);
    const counted = numberValue(line.counted_quantity);
    const currentBalance=await bindings.database.prepare("SELECT quantity_on_hand FROM inventory_balances WHERE inventory_item_id=? AND location_id=?").bind(itemId,numberValue(count.location_id)).first<{quantity_on_hand:number}>();
    const difference=counted-numberValue(currentBalance?.quantity_on_hand);
    statements.push(bindings.database.prepare("UPDATE inventory_items SET ingredient_id = COALESCE(ingredient_id, ?) WHERE id = ?")
      .bind(ingredientIds.get(itemId), itemId));
    if(difference!==0)statements.push(bindings.database.prepare(
      `INSERT INTO inventory_balances
       (inventory_item_id, location_id, quantity_on_hand, minimum_quantity,
        par_quantity, maximum_quantity, planning_active, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(inventory_item_id, location_id) DO UPDATE SET
         quantity_on_hand = excluded.quantity_on_hand, updated_at = CURRENT_TIMESTAMP`,
    ).bind(itemId, numberValue(count.location_id), counted));
    statements.push(bindings.database.prepare(
      `INSERT INTO stock_movements
       (ingredient_id, inventory_item_id, location_id, quantity_change, reason,
        source_event_key, created_by_user_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'COUNT', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(ingredientIds.get(itemId), itemId, numberValue(count.location_id), difference,
      `count:${countId}:item:${itemId}`, auth.user.id, `Posted from inventory count #${countId}`));
  }
  statements.push(bindings.database.prepare(
    `UPDATE inventory_counts SET status = 'POSTED', reviewed_by_user_id = ?,
      approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  ).bind(auth.user.id, countId));
  await bindings.database.batch(statements);
  return jsonResponse(request, await serializeCount(bindings.database, countId));
}

async function serializePurchaseOrder(database: D1Database, orderId: number): Promise<JsonObject | null> {
  const order = await database.prepare(
    `SELECT id, vendor_id, status, expected_date, notes, external_reference,
      imported_filename, created_by_user_id FROM inventory_purchase_orders WHERE id = ?`,
  ).bind(orderId).first<Record<string, unknown>>();
  if (order === null) return null;
  const lines = await database.prepare(
    `SELECT pol.id, pol.inventory_item_id, i.name AS item_name,
      pol.location_id, l.name AS location_name, pol.ordered_quantity,
      pol.unit_price_cents, pol.received_quantity,
      COALESCE(pol.purchase_unit, i.purchase_unit, i.base_unit) AS purchase_unit,
      pol.quantity_per_purchase_unit
     FROM inventory_purchase_order_lines pol
     JOIN inventory_items i ON i.id = pol.inventory_item_id
     LEFT JOIN inventory_locations l ON l.id = pol.location_id
     WHERE pol.purchase_order_id = ? ORDER BY pol.id`,
  ).bind(orderId).all<Record<string, unknown>>();
  return { ...order, lines: lines.results.map((line) => ({
    ...line,
    remaining_quantity: Math.max(0, numberValue(line.ordered_quantity) - numberValue(line.received_quantity)),
  })) };
}

async function listPurchaseOrders(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings);
  if (auth.response !== null) return auth.response;
  const ids = await bindings.database.prepare(
    "SELECT id FROM inventory_purchase_orders ORDER BY created_at DESC, id DESC",
  ).all<{ id: number }>();
  const rows = await Promise.all(ids.results.map((row) => serializePurchaseOrder(bindings.database, row.id)));
  return jsonResponse(request, rows.filter((row) => row !== null));
}

async function createOrUpdatePurchaseOrder(
  request: Request,
  bindings: RuntimeBindings,
  orderId?: number,
): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null || auth.user === null) return auth.response ?? apiError(request, 401, "Could not validate credentials");
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const vendorId = numberValue(body.vendor_id);
  const vendor = await bindings.database.prepare("SELECT id FROM inventory_vendors WHERE id = ? AND active = 1")
    .bind(vendorId).first();
  if (vendor === null) return apiError(request, 404, "Vendor not found");
  const lines = Array.isArray(body.lines) ? body.lines.filter(isObject) : [];
  const id = orderId ?? randomId();
  if (orderId !== undefined) {
    const existing = await bindings.database.prepare("SELECT status FROM inventory_purchase_orders WHERE id = ?")
      .bind(id).first<{ status: string }>();
    if (existing === null) return apiError(request, 404, "Purchase order not found");
    if (existing.status !== "DRAFT") return apiError(request, 409, "Only draft purchase orders can be edited");
  }
  const statements: D1PreparedStatement[] = [];
  if (orderId === undefined) {
    statements.push(bindings.database.prepare(
      `INSERT INTO inventory_purchase_orders
       (id, vendor_id, status, expected_date, notes, external_reference,
        import_source_hash, imported_filename, created_by_user_id, created_at, updated_at)
       VALUES (?, ?, 'DRAFT', ?, ?, NULL, NULL, NULL, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(id, vendorId, typeof body.expected_date === "string" ? body.expected_date : null,
      typeof body.notes === "string" ? body.notes : null, auth.user.id));
  } else {
    statements.push(bindings.database.prepare(
      `UPDATE inventory_purchase_orders SET vendor_id = ?, expected_date = ?, notes = ?,
       updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    ).bind(vendorId, typeof body.expected_date === "string" ? body.expected_date : null,
      typeof body.notes === "string" ? body.notes : null, id));
    statements.push(bindings.database.prepare("DELETE FROM inventory_purchase_order_lines WHERE purchase_order_id = ?").bind(id));
  }
  for (const line of lines) {
    const quantity = numberValue(line.ordered_quantity);
    if (quantity <= 0) return apiError(request, 422, "ordered_quantity must be greater than 0");
    statements.push(bindings.database.prepare(
      `INSERT INTO inventory_purchase_order_lines
       (id, purchase_order_id, inventory_item_id, location_id, ordered_quantity,
        unit_price_cents, received_quantity, purchase_unit, quantity_per_purchase_unit)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    ).bind(randomId(), id, numberValue(line.inventory_item_id),
      line.location_id === null || line.location_id === undefined ? null : numberValue(line.location_id),
      quantity, Math.max(0, Math.trunc(numberValue(line.unit_price_cents))),
      typeof line.purchase_unit === "string" ? line.purchase_unit : null,
      Math.max(0.0001, numberValue(line.quantity_per_purchase_unit, 1))));
  }
  try {
    await bindings.database.batch(statements);
  } catch (error) {
    if (error instanceof Error && /foreign key|constraint/iu.test(error.message)) {
      return apiError(request, 404, "Inventory item or location not found");
    }
    throw error;
  }
  return jsonResponse(request, await serializePurchaseOrder(bindings.database, id), { status: orderId === undefined ? 201 : 200 });
}

async function changePurchaseOrderStatus(
  request: Request,
  orderId: number,
  target: "SUBMITTED" | "CANCELLED",
  bindings: RuntimeBindings,
): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null) return auth.response;
  const order = await bindings.database.prepare("SELECT status FROM inventory_purchase_orders WHERE id = ?")
    .bind(orderId).first<{ status: string }>();
  if (order === null) return apiError(request, 404, "Purchase order not found");
  if (order.status !== "DRAFT") return apiError(request, 409, "Only draft purchase orders can be changed");
  await bindings.database.prepare(
    "UPDATE inventory_purchase_orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  ).bind(target, orderId).run();
  return jsonResponse(request, { id: orderId, status: target });
}

async function transfers(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null || auth.user === null) return auth.response ?? apiError(request, 401, "Could not validate credentials");
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const itemId = numberValue(body.inventory_item_id);
  const fromId = numberValue(body.from_location_id);
  const toId = numberValue(body.to_location_id);
  const quantity = numberValue(body.quantity);
  if (quantity <= 0 || fromId === toId) return apiError(request, 400, "Transfer quantity must be positive and locations must differ");
  const item = await bindings.database.prepare(
    "SELECT id, ingredient_id, name, base_unit FROM inventory_items WHERE id = ? AND active = 1",
  ).bind(itemId).first<Record<string, unknown>>();
  if (item === null) return apiError(request, 404, "Inventory item not found");
  if (!(await ensureLocation(bindings.database, fromId)) || !(await ensureLocation(bindings.database, toId))) {
    return apiError(request, 404, "Inventory location not found");
  }
  let ingredientId = item.ingredient_id === null ? null : numberValue(item.ingredient_id);
  if (ingredientId === null) {
    const externalId = `inventory-item-${itemId}`;
    const existingIngredient = await bindings.database.prepare(
      "SELECT id FROM ingredients WHERE external_id = ?",
    ).bind(externalId).first<{ id: number }>();
    if (existingIngredient !== null) ingredientId = existingIngredient.id;
    else {
      const created = await bindings.database.prepare(
        `INSERT INTO ingredients (external_id, name, normalized_name, unit, stage,
         added_to_complete_lineage, active) VALUES (?, ?, ?, ?, 'raw_material', 0, 1)
         RETURNING id`,
      ).bind(externalId, item.name, String(item.name).toLowerCase(), item.base_unit).first<{ id: number }>();
      ingredientId = created?.id ?? null;
    }
  }
  if (ingredientId === null) throw new Error("Could not create transfer ingredient");
  const userId = auth.user.id;
  const transferKey = `transfer:${crypto.randomUUID()}`;
  const notes = typeof body.notes === "string" ? body.notes : null;
  const movement = (locationId: number, amount: number, reason: string, suffix: string) => [
    bindings.database.prepare(
      `INSERT INTO inventory_balances
       (inventory_item_id, location_id, quantity_on_hand, minimum_quantity,
        par_quantity, maximum_quantity, planning_active, created_at, updated_at)
       VALUES (?, ?, ?, 0, 0, NULL, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(inventory_item_id, location_id) DO UPDATE SET
        quantity_on_hand = quantity_on_hand + excluded.quantity_on_hand,
        updated_at = CURRENT_TIMESTAMP`,
    ).bind(itemId, locationId, amount),
    bindings.database.prepare(
      `INSERT INTO stock_movements
       (ingredient_id, inventory_item_id, location_id, quantity_change, reason,
        source_event_key, created_by_user_id, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(ingredientId, itemId, locationId, amount, reason, `${transferKey}:${suffix}`, userId, notes),
  ];
  await bindings.database.batch([
    bindings.database.prepare("UPDATE inventory_items SET ingredient_id = COALESCE(ingredient_id, ?) WHERE id = ?")
      .bind(ingredientId, itemId),
    ...movement(fromId, -quantity, "TRANSFER_OUT", "out"),
    ...movement(toId, quantity, "TRANSFER_IN", "in"),
  ]);
  const rows = await bindings.database.prepare(
    `SELECT id, inventory_item_id, location_id, quantity_change, reason, notes,
      source_event_key, created_by_user_id, created_at, updated_at
     FROM stock_movements WHERE source_event_key IN (?, ?) ORDER BY id`,
  ).bind(`${transferKey}:out`, `${transferKey}:in`).all<Record<string, unknown>>();
  return jsonResponse(request, rows.results, { status: 201 });
}

async function planningRows(database: D1Database, locationId: number): Promise<JsonObject[]> {
  const [items, targets] = await database.batch([
    database.prepare(`SELECT i.id AS inventory_item_id, i.name AS item_name, i.category, i.base_unit,
      COALESCE(i.purchase_unit,i.base_unit) AS purchase_unit, i.purchase_to_base,
      b.planning_active,b.lower_tolerance_percent,b.upper_tolerance_percent,
      vi.vendor_id AS preferred_vendor_id,v.name AS preferred_vendor_name,vi.vendor_sku,
      COALESCE(vi.pack_quantity,i.purchase_to_base,1) AS pack_quantity,
      COALESCE(NULLIF(vi.unit_price_cents,0),ROUND(i.cost_cents*COALESCE(vi.pack_quantity,i.purchase_to_base,1)),0) AS unit_price_cents
      FROM inventory_items i LEFT JOIN inventory_balances b ON b.inventory_item_id=i.id AND b.location_id=?
      LEFT JOIN inventory_vendor_items vi ON vi.inventory_item_id=i.id AND vi.preferred=1
      LEFT JOIN inventory_vendors v ON v.id=vi.vendor_id AND v.active=1
      WHERE i.active=1 ORDER BY i.category,i.name`).bind(locationId),
    database.prepare("SELECT inventory_item_id,weekday,target_quantity FROM inventory_weekday_targets WHERE location_id=?").bind(locationId),
  ]);
  const mapped = new Map<number, Record<string, number | null>>();
  for (const row of targets.results as JsonObject[]) {
    const values = mapped.get(numberValue(row.inventory_item_id)) ?? Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), null]));
    values[String(row.weekday)] = numberValue(row.target_quantity); mapped.set(numberValue(row.inventory_item_id), values);
  }
  return (items.results as JsonObject[]).map((row) => ({ ...row,
    planning_active: booleanValue(row.planning_active, false),
    weekday_targets: mapped.get(numberValue(row.inventory_item_id)) ?? Object.fromEntries(Array.from({ length: 7 }, (_, day) => [String(day), null])),
    effective_lower_tolerance_percent: row.lower_tolerance_percent ?? 10,
    effective_upper_tolerance_percent: row.upper_tolerance_percent ?? 10,
  }));
}

async function planningSettings(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response> {
  const auth = request.method === "PUT" ? await requireManager(request, bindings) : await requireUser(request, bindings); if (auth.response !== null) return auth.response;
  if (request.method === "GET") {
    const locationId = numberValue(url.searchParams.get("location_id"));
    if (locationId <= 0) return apiError(request, 422, "location_id is required");
    if (await bindings.database.prepare("SELECT id FROM inventory_locations WHERE id=? AND active=1").bind(locationId).first() === null) return apiError(request, 404, "Inventory location not found");
    return jsonResponse(request, { location_id: locationId, default_tolerance_percent: 10, rows: await planningRows(bindings.database, locationId) });
  }
  if (request.method !== "PUT") return methodNotAllowed(request, "GET, PUT");
  const payload = await jsonBody(request); if (payload instanceof Response) return payload;
  const locationId = numberValue(payload.location_id); const rows = Array.isArray(payload.rows) ? payload.rows.filter(isObject) : [];
  if (locationId <= 0 || rows.length === 0) return apiError(request, 400, "Location and settings rows are required");
  const statements: D1PreparedStatement[] = []; const seen = new Set<number>();
  for (const row of rows) {
    const itemId = numberValue(row.inventory_item_id); if (seen.has(itemId)) return apiError(request, 400, "Each inventory item may appear only once"); seen.add(itemId);
    statements.push(bindings.database.prepare(`INSERT INTO inventory_balances
      (id,inventory_item_id,location_id,quantity_on_hand,minimum_quantity,par_quantity,maximum_quantity,planning_active,lower_tolerance_percent,upper_tolerance_percent,created_at,updated_at)
      VALUES (?,?,?,0,0,0,NULL,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(inventory_item_id,location_id) DO UPDATE SET planning_active=excluded.planning_active,lower_tolerance_percent=excluded.lower_tolerance_percent,upper_tolerance_percent=excluded.upper_tolerance_percent,updated_at=CURRENT_TIMESTAMP`)
      .bind(randomId(), itemId, locationId, row.planning_active === false ? 0 : 1, row.lower_tolerance_percent ?? null, row.upper_tolerance_percent ?? null));
    if (row.purchase_unit !== undefined || row.pack_quantity !== undefined || row.unit_price_cents !== undefined) {
      const packQuantity = numberValue(row.pack_quantity, 1);
      const unitPriceCents = Math.max(0, Math.trunc(numberValue(row.unit_price_cents)));
      if (packQuantity <= 0) return apiError(request, 422, "pack_quantity must be greater than 0");
      statements.push(bindings.database.prepare(
        `UPDATE inventory_items SET purchase_unit = COALESCE(?, purchase_unit),
          purchase_to_base = COALESCE(?, purchase_to_base),
          cost_cents = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      ).bind(row.purchase_unit ?? null, packQuantity, Math.round(unitPriceCents / packQuantity), itemId));
    }
    if (isObject(row.weekday_targets)) for (const [dayText, target] of Object.entries(row.weekday_targets)) {
      const day = numberValue(dayText, -1); if (day < 0 || day > 6) return apiError(request, 400, "Weekday keys must be between 0 and 6");
      statements.push(target === null
        ? bindings.database.prepare("DELETE FROM inventory_weekday_targets WHERE inventory_item_id=? AND location_id=? AND weekday=?").bind(itemId, locationId, day)
        : bindings.database.prepare(`INSERT INTO inventory_weekday_targets (id,inventory_item_id,location_id,weekday,target_quantity,created_at,updated_at)
          VALUES (?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(inventory_item_id,location_id,weekday) DO UPDATE SET target_quantity=excluded.target_quantity,updated_at=CURRENT_TIMESTAMP`)
          .bind(randomId(), itemId, locationId, day, numberValue(target)));
    }
    statements.push(bindings.database.prepare("UPDATE inventory_vendor_items SET preferred=0,updated_at=CURRENT_TIMESTAMP WHERE inventory_item_id=?").bind(itemId));
    if (row.preferred_vendor_id !== null && row.preferred_vendor_id !== undefined) statements.push(bindings.database.prepare(`INSERT INTO inventory_vendor_items
      (id,vendor_id,inventory_item_id,vendor_sku,unit_price_cents,pack_quantity,preferred,created_at,updated_at) VALUES (?,?,?,?,?,?,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
      ON CONFLICT(vendor_id,inventory_item_id) DO UPDATE SET vendor_sku=excluded.vendor_sku,unit_price_cents=excluded.unit_price_cents,pack_quantity=excluded.pack_quantity,preferred=1,updated_at=CURRENT_TIMESTAMP`)
      .bind(randomId(), numberValue(row.preferred_vendor_id), itemId, row.vendor_sku ?? null, numberValue(row.unit_price_cents), numberValue(row.pack_quantity, 1)));
  }
  await bindings.database.batch(statements);
  return jsonResponse(request, { location_id: locationId, default_tolerance_percent: 10, rows: await planningRows(bindings.database, locationId) });
}

function targetStatus(quantity: number, target: number | null, lower: number, upper: number): string {
  if (target === null) return "NOT_CONFIGURED"; if (target > 0 && quantity <= 0) return "OUT";
  if (quantity < target * (1 - lower / 100)) return "UNDER"; if (quantity > target * (1 + upper / 100)) return "OVER"; return "ON_TARGET";
}

async function purchasePlanner(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireUser(request, bindings); if (auth.response !== null) return auth.response;
  const locationId = numberValue(url.searchParams.get("location_id")); const deliveryDate = url.searchParams.get("delivery_date");
  if (locationId <= 0 || deliveryDate === null) return apiError(request, 422, "location_id and delivery_date are required");
  const weekday = (new Date(`${deliveryDate}T12:00:00Z`).getUTCDay() + 6) % 7;
  const result = await bindings.database.prepare(`SELECT i.id AS inventory_item_id,i.name AS item_name,i.category,i.base_unit,
    COALESCE(i.purchase_unit,i.base_unit) AS purchase_unit,l.id AS location_id,l.name AS location_name,b.quantity_on_hand AS expected_quantity,
    COALESCE(t.target_quantity,NULLIF(b.par_quantity,0)) AS target_quantity,COALESCE(b.lower_tolerance_percent,10) AS lower_tolerance_percent,
    COALESCE(b.upper_tolerance_percent,10) AS upper_tolerance_percent,vi.vendor_id AS preferred_vendor_id,v.name AS preferred_vendor_name,vi.vendor_sku,
    COALESCE(vi.pack_quantity,i.purchase_to_base,1) AS pack_quantity,COALESCE(NULLIF(vi.unit_price_cents,0),i.cost_cents*COALESCE(vi.pack_quantity,i.purchase_to_base,1)) AS unit_price_cents,
    COALESCE((SELECT SUM(MAX(pol.ordered_quantity-pol.received_quantity,0)*pol.quantity_per_purchase_unit) FROM inventory_purchase_order_lines pol
      JOIN inventory_purchase_orders po ON po.id=pol.purchase_order_id WHERE pol.inventory_item_id=i.id AND pol.location_id=l.id AND po.status IN ('SUBMITTED','PARTIALLY_RECEIVED')),0) AS incoming_quantity
    FROM inventory_balances b JOIN inventory_items i ON i.id=b.inventory_item_id JOIN inventory_locations l ON l.id=b.location_id
    LEFT JOIN inventory_weekday_targets t ON t.inventory_item_id=i.id AND t.location_id=l.id AND t.weekday=?
    LEFT JOIN inventory_vendor_items vi ON vi.inventory_item_id=i.id AND vi.preferred=1 LEFT JOIN inventory_vendors v ON v.id=vi.vendor_id AND v.active=1
    WHERE b.location_id=? AND b.planning_active=1 AND i.active=1 ORDER BY i.category,i.name`).bind(weekday, locationId).all<JsonObject>();
  const rows = result.results.map((row) => {
    const expected=numberValue(row.expected_quantity),incoming=numberValue(row.incoming_quantity),projected=expected+incoming;
    const target=row.target_quantity===null?null:numberValue(row.target_quantity),pack=Math.max(numberValue(row.pack_quantity,1),0.0001);
    const base=Math.max((target??0)-projected,0),recommended=base>0?Math.ceil(base/pack):0,lower=numberValue(row.lower_tolerance_percent,10),upper=numberValue(row.upper_tolerance_percent,10);
    return {...row,counted_quantity:null,counted_at:null,count_id:null,projected_quantity:projected,variance_quantity:target===null?null:projected-target,
      current_status:targetStatus(expected,target,lower,upper),status:targetStatus(projected,target,lower,upper),recommended_base_quantity:base,
      recommended_purchase_quantity:recommended,estimated_order_cost_cents:recommended*numberValue(row.unit_price_cents)};
  });
  return jsonResponse(request,{location_id:locationId,delivery_date:deliveryDate,weekday,rows});
}

async function receiveOrder(request:Request,bindings:RuntimeBindings):Promise<Response>{
  const auth=await requireManager(request,bindings);if(auth.response!==null||auth.user===null)return auth.response??apiError(request,401,"Could not validate credentials");
  const body=await jsonBody(request);if(body instanceof Response)return body;const orderId=numberValue(body.purchase_order_id),input=Array.isArray(body.lines)?body.lines.filter(isObject):[];
  const order=await bindings.database.prepare("SELECT id,status FROM inventory_purchase_orders WHERE id=?").bind(orderId).first<{id:number;status:string}>();if(!order)return apiError(request,404,"Purchase order not found");
  if(!["SUBMITTED","PARTIALLY_RECEIVED"].includes(order.status))return apiError(request,400,"Submit the purchase order before receiving it");if(input.length===0)return apiError(request,400,"At least one receiving line is required");
  const orderLines=await bindings.database.prepare(`SELECT pol.*,i.name,i.base_unit,i.ingredient_id FROM inventory_purchase_order_lines pol JOIN inventory_items i ON i.id=pol.inventory_item_id WHERE pol.purchase_order_id=?`).bind(orderId).all<JsonObject>();
  const resolved:{input:JsonObject;line:JsonObject;locationId:number;baseQuantity:number;ingredientId:number}[]=[];const pre:D1PreparedStatement[]=[];
  for(const entry of input){let line=entry.purchase_order_line_id==null?null:orderLines.results.find(row=>numberValue(row.id)===numberValue(entry.purchase_order_line_id));
    if(!line){const candidates=orderLines.results.filter(row=>numberValue(row.inventory_item_id)===numberValue(entry.inventory_item_id)&&(entry.location_id==null||numberValue(row.location_id)===numberValue(entry.location_id)));if(candidates.length===1)line=candidates[0]}
    if(!line||numberValue(line.inventory_item_id)!==numberValue(entry.inventory_item_id))return apiError(request,400,`${line?.name??"Inventory item"} is not a unique line on this order`);
    const locationId=entry.location_id==null?numberValue(line.location_id):numberValue(entry.location_id);if(locationId<=0||!(await ensureLocation(bindings.database,locationId)))return apiError(request,400,`Choose a receiving area for ${line.name}`);
    const quantity=numberValue(entry.received_quantity),remaining=Math.max(numberValue(line.ordered_quantity)-numberValue(line.received_quantity),0);if(quantity<=0)return apiError(request,400,"Received quantity must be greater than zero");if(quantity>remaining&&body.allow_overage!==true)return apiError(request,400,`Received quantity for ${line.name} exceeds the remaining ${remaining}`);
    let ingredientId=line.ingredient_id===null?null:numberValue(line.ingredient_id);if(ingredientId===null){ingredientId=randomId();pre.push(bindings.database.prepare(`INSERT INTO ingredients(id,external_id,name,normalized_name,unit,stage,added_to_complete_lineage,active) VALUES(?,?,?,?,?,'raw_material',0,1)`).bind(ingredientId,`inventory-item-${line.inventory_item_id}`,line.name,String(line.name).toLowerCase(),line.base_unit));pre.push(bindings.database.prepare("UPDATE inventory_items SET ingredient_id=? WHERE id=?").bind(ingredientId,line.inventory_item_id));}
    resolved.push({input:entry,line,locationId,baseQuantity:quantity*numberValue(line.quantity_per_purchase_unit,1),ingredientId});
  }
  const receivingId=randomId(),statements:D1PreparedStatement[]=[...pre,bindings.database.prepare(`INSERT INTO inventory_receiving(id,purchase_order_id,received_by_user_id,invoice_number,notes,created_at,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(receivingId,orderId,auth.user.id,body.invoice_number??null,body.notes??null)];
  for(const row of resolved){const quantity=numberValue(row.input.received_quantity),movementKey=`receiving:${receivingId}:po-line:${row.line.id}`;
    statements.push(bindings.database.prepare(`INSERT INTO inventory_receiving_lines(id,receiving_id,purchase_order_line_id,inventory_item_id,location_id,received_quantity,unit_price_cents,lot_number,expiration_date,notes) VALUES(?,?,?,?,?,?,?,?,?,?)`).bind(randomId(),receivingId,row.line.id,row.line.inventory_item_id,row.locationId,quantity,numberValue(row.input.unit_price_cents),row.input.lot_number??null,row.input.expiration_date??null,row.input.notes??null));
    statements.push(bindings.database.prepare("UPDATE inventory_purchase_order_lines SET received_quantity=received_quantity+? WHERE id=?").bind(quantity,row.line.id));
    statements.push(bindings.database.prepare(`INSERT INTO inventory_balances(id,inventory_item_id,location_id,quantity_on_hand,minimum_quantity,par_quantity,maximum_quantity,planning_active,created_at,updated_at) VALUES(?,?,?, ?,0,0,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP) ON CONFLICT(inventory_item_id,location_id) DO UPDATE SET quantity_on_hand=quantity_on_hand+excluded.quantity_on_hand,updated_at=CURRENT_TIMESTAMP`).bind(randomId(),row.line.inventory_item_id,row.locationId,row.baseQuantity));
    statements.push(bindings.database.prepare(`INSERT INTO stock_movements(ingredient_id,inventory_item_id,location_id,quantity_change,reason,source_event_key,created_by_user_id,lot_number,expiration_date,notes,created_at,updated_at) VALUES(?,?,?,?,'RECEIVE',?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(row.ingredientId,row.line.inventory_item_id,row.locationId,row.baseQuantity,movementKey,auth.user.id,row.input.lot_number??null,row.input.expiration_date??null,row.input.notes??null));
  }
  statements.push(bindings.database.prepare(`UPDATE inventory_purchase_orders SET status=CASE WHEN NOT EXISTS(SELECT 1 FROM inventory_purchase_order_lines WHERE purchase_order_id=? AND received_quantity<ordered_quantity) THEN 'RECEIVED' ELSE 'PARTIALLY_RECEIVED' END,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(orderId,orderId));
  await bindings.database.batch(statements);const updated=await bindings.database.prepare("SELECT status FROM inventory_purchase_orders WHERE id=?").bind(orderId).first<{status:string}>();
  return jsonResponse(request,{id:receivingId,purchase_order_id:orderId,status:updated?.status,lines:resolved.map(row=>({purchase_order_line_id:row.line.id,inventory_item_id:row.line.inventory_item_id,location_id:row.locationId,received_quantity:numberValue(row.input.received_quantity)}))},{status:201});
}

async function ordersFromPlan(request:Request,bindings:RuntimeBindings):Promise<Response>{
  const auth=await requireManager(request,bindings);if(auth.response!==null||auth.user===null)return auth.response??apiError(request,401,"Could not validate credentials");const body=await jsonBody(request);if(body instanceof Response)return body;
  const input=Array.isArray(body.lines)?body.lines.filter(isObject):[];if(input.length===0)return apiError(request,400,"At least one plan line is required");
  const grouped=new Map<number,{line:JsonObject;item:JsonObject}[]>(),seen=new Set<string>(),missing:string[]=[];
  for(const line of input){const itemId=numberValue(line.inventory_item_id),locationId=numberValue(line.location_id),key=`${itemId}:${locationId}`;if(seen.has(key))return apiError(request,400,"Each item and area may appear only once");seen.add(key);
    const item=await bindings.database.prepare(`SELECT i.*,vi.vendor_id,vi.unit_price_cents,vi.pack_quantity FROM inventory_items i
      JOIN inventory_balances b ON b.inventory_item_id=i.id AND b.location_id=? AND b.planning_active=1
      LEFT JOIN inventory_vendor_items vi ON vi.inventory_item_id=i.id AND vi.preferred=1 WHERE i.id=? AND i.active=1`).bind(locationId,itemId).first<JsonObject>();
    if(!item)return apiError(request,400,`Inventory item ${itemId} is not enabled for ordering in this area`);if(item.vendor_id===null){missing.push(String(item.name));continue}const rows=grouped.get(numberValue(item.vendor_id))??[];rows.push({line,item});grouped.set(numberValue(item.vendor_id),rows);
  }
  if(missing.length)return apiError(request,409,"Assign a preferred vendor before ordering: "+missing.slice(0,8).join(", "));
  const statements:D1PreparedStatement[]=[],orderIds:number[]=[];
  for(const [vendorId,rows] of grouped){const orderId=randomId();orderIds.push(orderId);statements.push(bindings.database.prepare(`INSERT INTO inventory_purchase_orders(id,vendor_id,status,expected_date,notes,external_reference,import_source_hash,imported_filename,created_by_user_id,created_at,updated_at) VALUES(?,?,'DRAFT',?,?,NULL,NULL,NULL,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(orderId,vendorId,body.expected_date,body.notes??null,auth.user.id));
    for(const {line,item} of rows){const pack=numberValue(item.pack_quantity,numberValue(item.purchase_to_base,1));const price=numberValue(item.unit_price_cents)||Math.round(numberValue(item.cost_cents)*pack);statements.push(bindings.database.prepare(`INSERT INTO inventory_purchase_order_lines(id,purchase_order_id,inventory_item_id,location_id,ordered_quantity,unit_price_cents,received_quantity,purchase_unit,quantity_per_purchase_unit) VALUES(?,?,?,?,?,?,0,?,?)`).bind(randomId(),orderId,item.id,line.location_id,numberValue(line.purchase_quantity),price,item.purchase_unit??item.base_unit,pack));}
  }
  await bindings.database.batch(statements);return jsonResponse(request,(await Promise.all(orderIds.map(orderId=>serializePurchaseOrder(bindings.database,orderId)))).filter(Boolean),{status:201});
}

function csvRecords(text:string):string[][]{const header=text.split(/\r?\n/u,1)[0]??"";const delimiter=[",","\t",";","|"].map(value=>({value,count:header.split(value).length-1})).sort((a,b)=>b.count-a.count)[0]?.value??",";const rows:string[][]=[];let row:string[]=[],field="",quoted=false;for(let index=0;index<text.length;index++){const char=text[index];if(char==='"'){if(quoted&&text[index+1]==='"'){field+='"';index++}else quoted=!quoted}else if(char===delimiter&&!quoted){row.push(field);field=""}else if((char==='\n'||char==='\r')&&!quoted){if(char==='\r'&&text[index+1]==='\n')index++;row.push(field);if(row.some(value=>value.trim()))rows.push(row);row=[];field=""}else field+=char}row.push(field);if(row.some(value=>value.trim()))rows.push(row);return rows}
function headerKey(value:string):string{return value.replace(/^\uFEFF/u,"").trim().toLowerCase().replace(/\([^)]*\)/gu," ").replace(/[^a-z0-9#]+/gu," ").trim()}
async function csvHash(vendorId:number,text:string):Promise<string>{const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(`${vendorId}\n${text.replace(/\r\n?/gu,"\n").trim().replace(/^\uFEFF/u,"")}`));return [...new Uint8Array(bytes)].map(value=>value.toString(16).padStart(2,"0")).join("")}

async function csvPreview(request:Request,bindings:RuntimeBindings,forImport=false):Promise<Response>{
  const auth=await requireManager(request,bindings);if(auth.response!==null||auth.user===null)return auth.response??apiError(request,401,"Could not validate credentials");const body=await jsonBody(request);if(body instanceof Response)return body;
  const vendorId=numberValue(body.vendor_id),text=typeof body.csv_text==="string"?body.csv_text:"";if(await bindings.database.prepare("SELECT id FROM inventory_vendors WHERE id=?").bind(vendorId).first()===null)return apiError(request,404,"Vendor not found");
  const records=csvRecords(text);if(records.length<2)return apiError(request,400,"The CSV needs a header row and at least one product row.");const aliases:Record<string,string[]>={item_name:["item","item name","product","product name","description","product description"],vendor_sku:["sku","vendor sku","item number","item no","item #","product code","code"],quantity:["quantity","qty","order qty","ordered quantity","cases","case quantity"],unit_price:["unit price","price","cost","unit cost","price each","each price"],line_total:["total","line total","extended price","extended cost","amount"],external_reference:["po number","po #","purchase order","purchase order number","order number","reference"]};
  const columns:Record<string,number>={};records[0].forEach((header,index)=>{const key=headerKey(header);for(const [name,values] of Object.entries(aliases))if(values.includes(key)&&columns[name]===undefined)columns[name]=index});if(columns.quantity===undefined)return apiError(request,400,"The CSV needs a quantity column (for example: Qty or Quantity).");if(columns.item_name===undefined&&columns.vendor_sku===undefined)return apiError(request,400,"The CSV needs an item description or SKU column.");
  const items=await bindings.database.prepare(`SELECT i.id,i.name,i.sku,vi.vendor_sku FROM inventory_items i LEFT JOIN inventory_vendor_items vi ON vi.inventory_item_id=i.id AND vi.vendor_id=? WHERE i.active=1`).bind(vendorId).all<JsonObject>();const overrides=isObject(body.item_overrides)?body.item_overrides:{};const locationOverrides=isObject(body.location_overrides)?body.location_overrides:{};const rows:JsonObject[]=[];let reference:string|null=null;
  for(let index=1;index<records.length;index++){const values=records[index],value=(name:string)=>columns[name]===undefined?"":(values[columns[name]]??"").trim(),itemName=value("item_name"),sku=value("vendor_sku"),quantity=Number(value("quantity").replace(/[$,]/gu,""));if(!itemName&&!sku&&!value("quantity"))continue;if(value("external_reference")&&!reference)reference=value("external_reference").slice(0,100);
    const priceRaw=value("unit_price").replace(/[$,]/gu,"");const totalRaw=value("line_total").replace(/[$,]/gu,"");const unitPrice=priceRaw?Math.round(Number(priceRaw)*100):totalRaw&&quantity>0?Math.round(Number(totalRaw)*100/quantity):0;const rowNumber=index+1;let candidates:JsonObject[]=[];let method:string|null=null;const override=numberValue(overrides[String(rowNumber)]);
    if(override){candidates=items.results.filter(item=>numberValue(item.id)===override);method="manual override"}else if(sku){const normalized=sku.toLowerCase().replace(/[^a-z0-9]/gu,"");candidates=items.results.filter(item=>String(item.vendor_sku??"").toLowerCase().replace(/[^a-z0-9]/gu,"")===normalized);method="vendor SKU";if(!candidates.length){candidates=items.results.filter(item=>String(item.sku??"").toLowerCase().replace(/[^a-z0-9]/gu,"")===normalized);method="inventory SKU"}}else if(itemName){candidates=items.results.filter(item=>String(item.name).trim().toLowerCase()===itemName.toLowerCase());method="exact name"}
    const invalid=!Number.isFinite(quantity)||quantity<=0||!Number.isFinite(unitPrice)||unitPrice<0;const matched=candidates.length===1;rows.push({row_number:rowNumber,item_name:itemName,vendor_sku:sku,quantity:invalid?null:String(quantity),unit_price_cents:invalid?null:unitPrice,status:invalid?"INVALID":matched?"MATCHED":candidates.length>1?"AMBIGUOUS":"UNMATCHED",message:invalid?"Quantity and price must be valid positive values.":matched?null:candidates.length>1?"More than one inventory item matches this row.":"Choose the inventory item for this product.",inventory_item_id:matched?candidates[0].id:null,inventory_item_name:matched?candidates[0].name:null,match_method:matched?method:null,suggestions:candidates.slice(0,3).map(item=>({inventory_item_id:item.id,name:item.name,sku:item.sku,score:1})),location_id:numberValue(locationOverrides[String(rowNumber)],numberValue(body.default_location_id))||null,location_name:null,planning:null});
  }
  if(!rows.length)return apiError(request,400,"No product rows were found in the CSV.");const sourceHash=await csvHash(vendorId,text),unresolved=rows.filter(row=>row.status==="UNMATCHED"||row.status==="AMBIGUOUS").length,invalid=rows.filter(row=>row.status==="INVALID").length;const duplicate=await bindings.database.prepare("SELECT id FROM inventory_purchase_orders WHERE import_source_hash=?").bind(sourceHash).first<{id:number}>();const preview={source_hash:sourceHash,external_reference:reference,detected_columns:Object.keys(columns).sort(),row_count:rows.length,matched_count:rows.filter(row=>row.status==="MATCHED").length,unresolved_count:unresolved,invalid_count:invalid,ready_to_import:unresolved+invalid===0,rows,duplicate_order_id:duplicate?.id??null};
  if(!forImport)return jsonResponse(request,preview);if(duplicate)return apiError(request,409,`This CSV was already imported as purchase order #${duplicate.id}.`);if(!preview.ready_to_import)return apiError(request,400,`Resolve all CSV rows before importing: ${unresolved} unmatched and ${invalid} invalid.`);
  const orderId=randomId(),statements:D1PreparedStatement[]=[bindings.database.prepare(`INSERT INTO inventory_purchase_orders(id,vendor_id,status,expected_date,notes,external_reference,import_source_hash,imported_filename,created_by_user_id,created_at,updated_at) VALUES(?,?,'DRAFT',?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(orderId,vendorId,body.expected_date??null,body.notes??null,body.external_reference??reference,sourceHash,typeof body.source_filename==="string"?body.source_filename.replace(/\\/gu,"/").split("/").pop():null,auth.user.id)];
  for(const row of rows){const item=items.results.find(candidate=>candidate.id===row.inventory_item_id)!;const vendorItem=await bindings.database.prepare("SELECT pack_quantity FROM inventory_vendor_items WHERE vendor_id=? AND inventory_item_id=?").bind(vendorId,row.inventory_item_id).first<{pack_quantity:number}>();const full=await bindings.database.prepare("SELECT base_unit,purchase_unit,purchase_to_base FROM inventory_items WHERE id=?").bind(row.inventory_item_id).first<JsonObject>();statements.push(bindings.database.prepare(`INSERT INTO inventory_purchase_order_lines(id,purchase_order_id,inventory_item_id,location_id,ordered_quantity,unit_price_cents,received_quantity,purchase_unit,quantity_per_purchase_unit) VALUES(?,?,?,?,?,?,0,?,?)`).bind(randomId(),orderId,item.id,row.location_id,numberValue(row.quantity),row.unit_price_cents,full?.purchase_unit??full?.base_unit,vendorItem?.pack_quantity??full?.purchase_to_base??1));}
  try{await bindings.database.batch(statements)}catch(error){if(error instanceof Error&&/UNIQUE/iu.test(error.message))return apiError(request,409,"This purchase order CSV or vendor reference was imported by another request.");throw error}return jsonResponse(request,await serializePurchaseOrder(bindings.database,orderId),{status:201});
}

function easyNormalize(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim().replace(/\s+/gu, " ");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function easyData(database: D1Database): Promise<{
  items: JsonObject[];
  locations: JsonObject[];
  vendors: JsonObject[];
  balances: JsonObject[];
  vendorItems: JsonObject[];
  ingredients: JsonObject[];
}> {
  const [items, locations, vendors, balances, vendorItems, ingredients] = await database.batch([
    database.prepare(`SELECT id,ingredient_id,name,category,sku,base_unit,purchase_unit,
      purchase_to_base,default_location_id,cost_cents,shelf_life_days,active,created_at,updated_at
      FROM inventory_items WHERE active=1 ORDER BY category,name`),
    database.prepare("SELECT id,name,description,active FROM inventory_locations WHERE active=1 ORDER BY name"),
    database.prepare(`SELECT id,name,contact_name,email,phone,lead_time_days,active,created_at,updated_at
      FROM inventory_vendors WHERE active=1 ORDER BY name`),
    database.prepare(`SELECT id,inventory_item_id,location_id,quantity_on_hand,minimum_quantity,
      par_quantity,maximum_quantity,planning_active FROM inventory_balances`),
    database.prepare(`SELECT vi.id,vi.vendor_id,vi.inventory_item_id,vi.vendor_sku,vi.unit_price_cents,
      vi.pack_quantity,vi.preferred,v.name AS vendor_name FROM inventory_vendor_items vi
      LEFT JOIN inventory_vendors v ON v.id=vi.vendor_id WHERE vi.preferred=1`),
    database.prepare(`SELECT id,external_id,name,normalized_name,category,unit,active
      FROM ingredients WHERE active=1 ORDER BY name`),
  ]);
  return {
    items: items.results as JsonObject[],
    locations: locations.results as JsonObject[],
    vendors: vendors.results as JsonObject[],
    balances: balances.results as JsonObject[],
    vendorItems: vendorItems.results as JsonObject[],
    ingredients: ingredients.results as JsonObject[],
  };
}

async function easyBootstrap(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null) return auth.response;
  const locationId = numberValue(url.searchParams.get("location_id"));
  if (locationId <= 0) return apiError(request, 422, "location_id is required");
  const data = await easyData(bindings.database);
  const location = data.locations.find((row) => numberValue(row.id) === locationId);
  if (!location) return apiError(request, 404, "Inventory location not found");
  const balances = new Map(data.balances.filter((row) => numberValue(row.location_id) === locationId)
    .map((row) => [numberValue(row.inventory_item_id), row]));
  const preferred = new Map(data.vendorItems.map((row) => [numberValue(row.inventory_item_id), row]));
  const ingredients = new Map(data.ingredients.map((row) => [numberValue(row.id), row]));
  const rows = data.items.map((item) => {
    const itemId = numberValue(item.id);
    const balance = balances.get(itemId);
    const vendor = preferred.get(itemId);
    const packQuantity = numberValue(vendor?.pack_quantity ?? item.purchase_to_base, 1);
    const packCost = numberValue(vendor?.unit_price_cents, Math.round(numberValue(item.cost_cents) * packQuantity));
    return {
      client_row_id: `item-${itemId}`,
      action: balance ? "UPDATE" : "STOCK_AT_LOCATION",
      inventory_item_id: itemId,
      catalog_id: ingredients.get(numberValue(item.ingredient_id))?.external_id ?? null,
      name: item.name,
      category: item.category,
      sku: item.sku,
      base_unit: item.base_unit,
      location_id: locationId,
      purchase_unit: item.purchase_unit ?? item.base_unit,
      pack_quantity: packQuantity,
      pack_cost_cents: packCost,
      base_unit_cost_cents: numberValue(item.cost_cents),
      opening_quantity: null,
      minimum_quantity: numberValue(balance?.minimum_quantity),
      par_quantity: numberValue(balance?.par_quantity),
      maximum_quantity: balance?.maximum_quantity ?? null,
      quantity_on_hand: numberValue(balance?.quantity_on_hand),
      has_balance: Boolean(balance),
      preferred_vendor_id: vendor?.vendor_id ?? null,
      preferred_vendor_name: vendor?.vendor_name ?? null,
      vendor_sku: vendor?.vendor_sku ?? null,
      shelf_life_days: item.shelf_life_days,
      updated_at: iso(String(item.updated_at)),
    };
  });
  const categories = [...new Set(data.items.map((item) => item.category).filter((value): value is string => typeof value === "string"))].sort();
  return jsonResponse(request, {
    location_id: locationId,
    location_name: location.name,
    locations: data.locations.map((row) => ({ id: row.id, name: row.name, description: row.description })),
    vendors: data.vendors.map((row) => ({ id: row.id, name: row.name, lead_time_days: row.lead_time_days })),
    categories,
    rows,
  });
}

async function easyPreviewRows(database: D1Database, inputRows: JsonObject[]): Promise<JsonObject[]> {
  const data = await easyData(database);
  const itemById = new Map(data.items.map((row) => [numberValue(row.id), row]));
  const locations = new Set(data.locations.map((row) => numberValue(row.id)));
  const vendors = new Set(data.vendors.map((row) => numberValue(row.id)));
  const balances = new Map(data.balances.map((row) => [`${row.inventory_item_id}:${row.location_id}`, row]));
  const preferred = new Map(data.vendorItems.map((row) => [numberValue(row.inventory_item_id), row]));
  const skuMap = new Map<string, JsonObject[]>();
  const nameMap = new Map<string, JsonObject[]>();
  for (const item of data.items) {
    if (typeof item.sku === "string" && item.sku.trim()) {
      const key = item.sku.trim().toLowerCase();
      skuMap.set(key, [...(skuMap.get(key) ?? []), item]);
    }
    const name = easyNormalize(item.name);
    nameMap.set(name, [...(nameMap.get(name) ?? []), item]);
  }
  const ingredientByExternal = new Map(data.ingredients.filter((row) => typeof row.external_id === "string")
    .map((row) => [String(row.external_id), row]));
  const ingredientByName = new Map(data.ingredients.map((row) => [easyNormalize(row.name), row]));
  const clientIds = new Set<string>();
  const proposedSkus = new Set<string>();
  const proposedNames = new Set<string>();
  const proposedTargets = new Set<string>();

  return inputRows.map((input, index) => {
    const errors: string[] = [];
    const warnings: string[] = [];
    const clientRowId = typeof input.client_row_id === "string" ? input.client_row_id.trim() : "";
    if (!clientRowId) errors.push("Client row ID is required.");
    else if (clientIds.has(clientRowId)) errors.push("Client row IDs must be unique.");
    clientIds.add(clientRowId);
    let item = input.inventory_item_id === null || input.inventory_item_id === undefined
      ? undefined : itemById.get(numberValue(input.inventory_item_id));
    if (input.inventory_item_id !== null && input.inventory_item_id !== undefined && !item) {
      errors.push("Inventory item was not found or is inactive.");
    }
    const name = String(Object.hasOwn(input, "name") ? input.name ?? "" : item?.name ?? "").trim();
    const sku = Object.hasOwn(input, "sku")
      ? (typeof input.sku === "string" && input.sku.trim() ? input.sku.trim() : null)
      : (typeof item?.sku === "string" ? item.sku : null);
    if (!item) {
      let candidates = sku ? (skuMap.get(sku.toLowerCase()) ?? []) : [];
      if (!candidates.length && name) candidates = nameMap.get(easyNormalize(name)) ?? [];
      if (candidates.length === 1) {
        item = candidates[0];
        warnings.push(`Matched existing inventory item #${item.id}.`);
      } else if (candidates.length > 1) errors.push("Multiple existing items match this row; choose one explicitly.");
    }
    if (!name) errors.push("Item name is required.");
    const locationId = numberValue(input.location_id);
    if (!locations.has(locationId)) errors.push("Choose an active inventory location.");
    const vendorId = input.preferred_vendor_id === null || input.preferred_vendor_id === undefined
      ? null : numberValue(input.preferred_vendor_id);
    if (vendorId !== null && !vendors.has(vendorId)) errors.push("Preferred vendor was not found or is inactive.");
    const itemId = item ? numberValue(item.id) : null;
    const currentVendor = itemId === null ? undefined : preferred.get(itemId);
    const baseUnit = String(Object.hasOwn(input, "base_unit") ? input.base_unit ?? "" : item?.base_unit ?? "").trim();
    if (!baseUnit) errors.push("Count unit is required.");
    const purchaseUnit = Object.hasOwn(input, "purchase_unit")
      ? (typeof input.purchase_unit === "string" && input.purchase_unit.trim() ? input.purchase_unit.trim() : null)
      : (typeof item?.purchase_unit === "string" ? item.purchase_unit : (item ? null : baseUnit));
    const packQuantity = numberValue(input.pack_quantity, numberValue(currentVendor?.pack_quantity ?? item?.purchase_to_base, 1));
    if (packQuantity <= 0) errors.push("Units per pack must be greater than zero.");
    const packCost = input.pack_cost_cents === null || input.pack_cost_cents === undefined
      ? numberValue(currentVendor?.unit_price_cents, Math.round(numberValue(item?.cost_cents) * packQuantity))
      : Math.trunc(numberValue(input.pack_cost_cents, -1));
    if (packCost < 0) errors.push("Pack cost cannot be negative.");
    const baseCost = packQuantity > 0 ? Math.round(packCost / packQuantity) : 0;
    const opening = input.opening_quantity === null || input.opening_quantity === undefined ? null : numberValue(input.opening_quantity, -1);
    const balance = itemId === null ? undefined : balances.get(`${itemId}:${locationId}`);
    const minimum = input.minimum_quantity === null || input.minimum_quantity === undefined
      ? numberValue(balance?.minimum_quantity) : numberValue(input.minimum_quantity, -1);
    const par = input.par_quantity === null || input.par_quantity === undefined
      ? numberValue(balance?.par_quantity) : numberValue(input.par_quantity, -1);
    const maximum = Object.hasOwn(input, "maximum_quantity")
      ? (input.maximum_quantity === null ? null : numberValue(input.maximum_quantity, -1))
      : (balance?.maximum_quantity === null || balance?.maximum_quantity === undefined
        ? null : numberValue(balance.maximum_quantity, -1));
    if (minimum < 0 || par < 0 || (opening !== null && opening < 0) || (maximum !== null && maximum < 0)) errors.push("Inventory quantities cannot be negative.");
    if (maximum !== null && maximum < Math.max(minimum, par)) errors.push("Maximum quantity must be at least the minimum and par quantities.");
    if (opening !== null && opening > 0 && balance) errors.push("Opening quantity is only allowed for a new item/location balance.");
    const action = itemId === null ? "CREATE" : balance ? "UPDATE" : "STOCK_AT_LOCATION";
    if (sku) {
      const key = sku.toLowerCase();
      if (proposedSkus.has(key) && itemId === null) errors.push("SKU is duplicated in this batch.");
      proposedSkus.add(key);
    }
    const normalizedName = easyNormalize(name);
    if (itemId === null && normalizedName) {
      if (proposedNames.has(normalizedName)) errors.push("Item name is duplicated in this batch.");
      proposedNames.add(normalizedName);
    }
    if (itemId !== null && locationId > 0) {
      const target = `${itemId}:${locationId}`;
      if (proposedTargets.has(target)) errors.push("The same item and location appears more than once in this batch.");
      proposedTargets.add(target);
    }
    let catalogId = typeof input.catalog_id === "string" && input.catalog_id ? input.catalog_id : null;
    let catalogIngredient = catalogId ? ingredientByExternal.get(catalogId) : undefined;
    if (!catalogIngredient && catalogId === null && itemId === null) {
      const exact = ingredientByName.get(normalizedName);
      if (exact && typeof exact.external_id === "string") {
        catalogIngredient = exact;
        catalogId = exact.external_id;
        warnings.push(`Matched catalog item ${String(exact.name)}.`);
      }
    }
    if (catalogId && !catalogIngredient) errors.push("Catalog ingredient was not found or is inactive.");
    const exactIngredient = catalogIngredient ?? ingredientByName.get(easyNormalize(name));
    const matches: JsonObject[] = data.items.filter((candidate) => numberValue(candidate.id) !== itemId && normalizedName &&
      (easyNormalize(candidate.name).includes(normalizedName) || normalizedName.includes(easyNormalize(candidate.name))))
      .slice(0, 5).map((candidate) => ({ source: "inventory", id: candidate.id, name: candidate.name, sku: candidate.sku }));
    if (itemId === null && matches.length < 5) {
      matches.push(...data.ingredients.filter((candidate) => normalizedName &&
        (easyNormalize(candidate.name).includes(normalizedName) || normalizedName.includes(easyNormalize(candidate.name))))
        .slice(0, 5 - matches.length).map((candidate) => ({ source: "catalog", id: candidate.external_id, name: candidate.name, sku: null })));
    }
    return {
      row_number: index + 1,
      client_row_id: clientRowId,
      action,
      inventory_item_id: itemId,
      ingredient_id: item?.ingredient_id ?? exactIngredient?.id ?? null,
      catalog_id: catalogId,
      name,
      category: Object.hasOwn(input, "category") ? input.category ?? null : item?.category ?? null,
      sku,
      base_unit: baseUnit,
      location_id: locationId,
      purchase_unit: purchaseUnit,
      pack_quantity: packQuantity,
      pack_cost_cents: packCost,
      base_unit_cost_cents: baseCost,
      opening_quantity: opening,
      minimum_quantity: minimum,
      par_quantity: par,
      maximum_quantity: maximum,
      preferred_vendor_id: input.preferred_vendor_id !== undefined ? vendorId : currentVendor?.vendor_id ?? null,
      vendor_sku: input.vendor_sku !== undefined ? input.vendor_sku : currentVendor?.vendor_sku ?? null,
      shelf_life_days: input.shelf_life_days !== undefined ? input.shelf_life_days : item?.shelf_life_days ?? null,
      balance_id: balance?.id ?? null,
      has_balance: Boolean(balance),
      quantity_on_hand: numberValue(balance?.quantity_on_hand),
      match_candidates: matches,
      warnings,
      errors,
    };
  });
}

async function easyPreview(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null) return auth.response;
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const rows = Array.isArray(body.rows) ? body.rows.filter(isObject) : [];
  if (!rows.length || rows.length > 250) return apiError(request, 422, "Easy Inventory Manager requires between 1 and 250 rows");
  const preview = await easyPreviewRows(bindings.database, rows);
  return jsonResponse(request, { valid: preview.every((row) => Array.isArray(row.errors) && row.errors.length === 0), row_count: preview.length, rows: preview });
}

async function easyCommit(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await requireManager(request, bindings);
  if (auth.response !== null || auth.user === null) return auth.response ?? apiError(request, 401, "Could not validate credentials");
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const key = typeof body.idempotency_key === "string" ? body.idempotency_key.trim() : "";
  const rows = Array.isArray(body.rows) ? body.rows.filter(isObject) : [];
  if (key.length < 8 || key.length > 100) return apiError(request, 422, "idempotency_key must contain 8 to 100 characters");
  if (!rows.length || rows.length > 250) return apiError(request, 422, "Easy Inventory Manager requires between 1 and 250 rows");
  const requestHash = await sha256Hex(stableJson(body));
  const existing = await bindings.database.prepare(`SELECT request_hash,response_json FROM inventory_easy_manager_commits
    WHERE idempotency_key=?`).bind(key).first<{ request_hash: string; response_json: string }>();
  if (existing) {
    if (existing.request_hash !== requestHash) return apiError(request, 409, "Idempotency key was already used with different inventory data");
    return jsonResponse(request, JSON.parse(existing.response_json), { status: 201 });
  }
  const preview = await easyPreviewRows(bindings.database, rows);
  const invalid = preview.filter((row) => Array.isArray(row.errors) && row.errors.length > 0);
  if (invalid.length) return jsonResponse(request, { detail: { message: "Resolve invalid Easy Inventory Manager rows", rows: invalid } }, { status: 400 });

  let createdCount = 0;
  let updatedCount = 0;
  let stockedCount = 0;
  const movementIds: number[] = [];
  const writeRows = preview.map((row) => {
    const isCreate = row.action === "CREATE";
    const itemId = isCreate ? randomId() : numberValue(row.inventory_item_id);
    let ingredientId = row.ingredient_id === null || row.ingredient_id === undefined ? null : numberValue(row.ingredient_id);
    const opening = numberValue(row.opening_quantity);
    const createIngredient = opening > 0 && ingredientId === null;
    if (createIngredient) ingredientId = randomId();
    const balanceId = row.balance_id === null || row.balance_id === undefined ? randomId() : numberValue(row.balance_id);
    const movementId = opening > 0 ? randomId() : null;
    if (movementId !== null) movementIds.push(movementId);
    if (isCreate) createdCount += 1; else updatedCount += 1;
    if (!row.has_balance) stockedCount += 1;
    return { ...row, item_id: itemId, ingredient_id: ingredientId, create_ingredient: createIngredient,
      balance_id: balanceId, vendor_item_id: randomId(), movement_id: movementId,
      source_event_key: `easy:${key}:${row.client_row_id}` };
  });
  const responseRows = writeRows.map((row, index) => ({ client_row_id: preview[index].client_row_id, action: preview[index].action,
    inventory_item_id: row.item_id, balance_id: row.balance_id, opening_movement_id: row.movement_id }));
  const response = { idempotency_key: key, created_count: createdCount, updated_count: updatedCount,
    stocked_count: stockedCount, opening_movement_ids: movementIds, rows: responseRows };
  const encoded = JSON.stringify(writeRows);
  const statements = [
    bindings.database.prepare(`INSERT INTO ingredients
      (id,name,unit,active,external_id,normalized_name,category,stage,added_to_complete_lineage)
      SELECT json_extract(value,'$.ingredient_id'),json_extract(value,'$.name'),json_extract(value,'$.base_unit'),1,
        'inventory-item-'||json_extract(value,'$.item_id'),LOWER(json_extract(value,'$.name')),
        json_extract(value,'$.category'),'raw_material',0 FROM json_each(?)
      WHERE json_extract(value,'$.create_ingredient')=1`).bind(encoded),
    bindings.database.prepare(`INSERT INTO inventory_items
      (id,ingredient_id,name,category,sku,base_unit,purchase_unit,purchase_to_base,default_location_id,cost_cents,shelf_life_days,active,created_at,updated_at)
      SELECT json_extract(value,'$.item_id'),json_extract(value,'$.ingredient_id'),json_extract(value,'$.name'),
        json_extract(value,'$.category'),json_extract(value,'$.sku'),json_extract(value,'$.base_unit'),
        json_extract(value,'$.purchase_unit'),json_extract(value,'$.pack_quantity'),json_extract(value,'$.location_id'),
        json_extract(value,'$.base_unit_cost_cents'),json_extract(value,'$.shelf_life_days'),1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
      FROM json_each(?) WHERE json_extract(value,'$.action')='CREATE'`).bind(encoded),
    bindings.database.prepare(`WITH input AS (SELECT value FROM json_each(?)) UPDATE inventory_items SET
      ingredient_id=COALESCE(ingredient_id,(SELECT json_extract(value,'$.ingredient_id') FROM input WHERE json_extract(value,'$.item_id')=inventory_items.id)),
      name=(SELECT json_extract(value,'$.name') FROM input WHERE json_extract(value,'$.item_id')=inventory_items.id),
      category=(SELECT json_extract(value,'$.category') FROM input WHERE json_extract(value,'$.item_id')=inventory_items.id),
      sku=(SELECT json_extract(value,'$.sku') FROM input WHERE json_extract(value,'$.item_id')=inventory_items.id),
      base_unit=(SELECT json_extract(value,'$.base_unit') FROM input WHERE json_extract(value,'$.item_id')=inventory_items.id),
      purchase_unit=(SELECT json_extract(value,'$.purchase_unit') FROM input WHERE json_extract(value,'$.item_id')=inventory_items.id),
      purchase_to_base=(SELECT json_extract(value,'$.pack_quantity') FROM input WHERE json_extract(value,'$.item_id')=inventory_items.id),
      cost_cents=(SELECT json_extract(value,'$.base_unit_cost_cents') FROM input WHERE json_extract(value,'$.item_id')=inventory_items.id),
      shelf_life_days=(SELECT json_extract(value,'$.shelf_life_days') FROM input WHERE json_extract(value,'$.item_id')=inventory_items.id),
      updated_at=CURRENT_TIMESTAMP WHERE id IN (SELECT json_extract(value,'$.item_id') FROM input WHERE json_extract(value,'$.action')!='CREATE')`).bind(encoded),
    bindings.database.prepare(`INSERT INTO inventory_balances
      (id,inventory_item_id,location_id,quantity_on_hand,minimum_quantity,par_quantity,maximum_quantity,planning_active,created_at,updated_at)
      SELECT json_extract(value,'$.balance_id'),json_extract(value,'$.item_id'),json_extract(value,'$.location_id'),
        COALESCE(json_extract(value,'$.opening_quantity'),0),json_extract(value,'$.minimum_quantity'),
        json_extract(value,'$.par_quantity'),json_extract(value,'$.maximum_quantity'),1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
      FROM json_each(?) WHERE 1 ON CONFLICT(inventory_item_id,location_id) DO UPDATE SET
        minimum_quantity=excluded.minimum_quantity,par_quantity=excluded.par_quantity,maximum_quantity=excluded.maximum_quantity,
        updated_at=CURRENT_TIMESTAMP`).bind(encoded),
    bindings.database.prepare(`UPDATE inventory_vendor_items SET preferred=0,updated_at=CURRENT_TIMESTAMP
      WHERE inventory_item_id IN (SELECT json_extract(value,'$.item_id') FROM json_each(?))`).bind(encoded),
    bindings.database.prepare(`INSERT INTO inventory_vendor_items
      (id,vendor_id,inventory_item_id,vendor_sku,unit_price_cents,pack_quantity,preferred,created_at,updated_at)
      SELECT json_extract(value,'$.vendor_item_id'),json_extract(value,'$.preferred_vendor_id'),json_extract(value,'$.item_id'),
        json_extract(value,'$.vendor_sku'),json_extract(value,'$.pack_cost_cents'),json_extract(value,'$.pack_quantity'),1,
        CURRENT_TIMESTAMP,CURRENT_TIMESTAMP FROM json_each(?) WHERE json_extract(value,'$.preferred_vendor_id') IS NOT NULL
      AND 1 ON CONFLICT(vendor_id,inventory_item_id) DO UPDATE SET vendor_sku=excluded.vendor_sku,
        unit_price_cents=excluded.unit_price_cents,pack_quantity=excluded.pack_quantity,preferred=1,updated_at=CURRENT_TIMESTAMP`).bind(encoded),
    bindings.database.prepare(`INSERT INTO stock_movements
      (id,ingredient_id,inventory_item_id,location_id,quantity_change,reason,source_event_key,created_by_user_id,notes,created_at,updated_at)
      SELECT json_extract(value,'$.movement_id'),json_extract(value,'$.ingredient_id'),json_extract(value,'$.item_id'),
        json_extract(value,'$.location_id'),json_extract(value,'$.opening_quantity'),'EASY_MANAGER_OPENING_BALANCE',
        json_extract(value,'$.source_event_key'),?,'Opening quantity from Easy Inventory Manager',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP
      FROM json_each(?) WHERE COALESCE(json_extract(value,'$.opening_quantity'),0)>0`).bind(auth.user.id, encoded),
    bindings.database.prepare(`INSERT INTO inventory_easy_manager_commits
      (id,idempotency_key,request_hash,response_json,created_by_user_id,created_at,updated_at)
      VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(randomId(), key, requestHash, JSON.stringify(response), auth.user.id),
  ];
  try {
    await bindings.database.batch(statements);
  } catch (error) {
    if (error instanceof Error && /unique|constraint|foreign key/iu.test(error.message)) {
      return apiError(request, 409, "Inventory changed while this Easy Inventory Manager batch was saving");
    }
    throw error;
  }
  return jsonResponse(request, response, { status: 201 });
}

export async function routeInventoryDomain(
  request: Request,
  url: URL,
  bindings: RuntimeBindings,
): Promise<Response | null> {
  const method = request.method;
  if (url.pathname === "/inventory/easy-manager") return method === "GET" ? easyBootstrap(request, url, bindings) : methodNotAllowed(request, "GET");
  if (url.pathname === "/inventory/easy-manager/preview") return method === "POST" ? easyPreview(request, bindings) : methodNotAllowed(request, "POST");
  if (url.pathname === "/inventory/easy-manager/commit") return method === "POST" ? easyCommit(request, bindings) : methodNotAllowed(request, "POST");
  if (url.pathname === "/inventory/settings/targets") return planningSettings(request, url, bindings);
  if (url.pathname === "/inventory/purchase-order-planner") return method === "GET" ? purchasePlanner(request, url, bindings) : methodNotAllowed(request, "GET");
  if (url.pathname === "/inventory/receiving") return method === "POST" ? receiveOrder(request, bindings) : methodNotAllowed(request, "POST");
  if (url.pathname === "/inventory/purchase-orders/from-plan") return method === "POST" ? ordersFromPlan(request, bindings) : methodNotAllowed(request, "POST");
  if (url.pathname === "/inventory/purchase-orders/import-preview") return method === "POST" ? csvPreview(request, bindings) : methodNotAllowed(request, "POST");
  if (url.pathname === "/inventory/purchase-orders/import-csv") return method === "POST" ? csvPreview(request, bindings, true) : methodNotAllowed(request, "POST");
  if (url.pathname === "/inventory/locations") {
    if (method === "GET") return listLocations(request, bindings);
    if (method === "POST") return createLocation(request, bindings);
    return methodNotAllowed(request, "GET, POST");
  }
  if (url.pathname === "/inventory/items") {
    if (method === "GET") return listItems(request, url, bindings);
    if (method === "POST") return createItem(request, bindings);
    return methodNotAllowed(request, "GET, POST");
  }
  if (url.pathname === "/inventory/items/from-catalog") return method === "POST" ? activateCatalogItem(request, bindings) : methodNotAllowed(request, "POST");
  const itemMatch = /^\/inventory\/items\/(\d+)$/u.exec(url.pathname);
  if (itemMatch !== null) {
    return method === "PUT"
      ? updateItem(request, Number(itemMatch[1]), bindings)
      : methodNotAllowed(request, "PUT");
  }
  const balanceMatch = /^\/inventory\/items\/(\d+)\/balances$/u.exec(url.pathname);
  if (balanceMatch !== null) {
    if (method === "GET") return listBalances(request, Number(balanceMatch[1]), bindings);
    if (method === "PUT") return upsertBalance(request, Number(balanceMatch[1]), bindings);
    return methodNotAllowed(request, "GET, PUT");
  }
  if (url.pathname === "/inventory/vendors") {
    if (method === "GET") return listVendors(request, bindings);
    if (method === "POST") return createVendor(request, bindings);
    return methodNotAllowed(request, "GET, POST");
  }
  if (url.pathname === "/inventory/vendor-items") {
    return method === "POST"
      ? createVendorItem(request, bindings)
      : methodNotAllowed(request, "POST");
  }
  if (url.pathname === "/inventory/stock") {
    return method === "GET" ? stock(request, url, bindings) : methodNotAllowed(request, "GET");
  }
  if (url.pathname === "/inventory/dashboard") {
    return method === "GET" ? dashboard(request, bindings) : methodNotAllowed(request, "GET");
  }
  if (url.pathname === "/inventory/movements") {
    if (method === "GET") return listMovements(request, url, bindings);
    if (method === "POST") return postMovement(request, bindings);
    return methodNotAllowed(request, "GET, POST");
  }
  if (url.pathname === "/inventory/waste") {
    return method === "POST" ? postMovement(request, bindings, "WASTE") : methodNotAllowed(request, "POST");
  }
  if (url.pathname === "/inventory/adjustments") {
    return method === "POST" ? postMovement(request, bindings, "ADJUSTMENT") : methodNotAllowed(request, "POST");
  }
  if (url.pathname === "/inventory/transfers") {
    return method === "POST" ? transfers(request, bindings) : methodNotAllowed(request, "POST");
  }
  if (url.pathname === "/inventory/counts") {
    if (method === "GET") return listCounts(request, bindings);
    if (method === "POST") return createCount(request, bindings);
    return methodNotAllowed(request, "GET, POST");
  }
  const countStatusMatch = /^\/inventory\/counts\/(\d+)\/(submit|post)$/u.exec(url.pathname);
  if (countStatusMatch !== null) {
    return method === "POST"
      ? changeCountStatus(request, Number(countStatusMatch[1]), countStatusMatch[2] === "submit" ? "SUBMITTED" : "POSTED", bindings)
      : methodNotAllowed(request, "POST");
  }
  if (url.pathname === "/inventory/count-templates") {
    return countTemplates(request,bindings);
  }
  if(url.pathname==="/inventory/count-sheets"){
    if(method==="GET")return listCountSheets(request,url,bindings);if(method==="POST")return createCountSheet(request,bindings);return methodNotAllowed(request,"GET, POST");
  }
  const countSheetMatch=/^\/inventory\/count-sheets\/(\d+)$/u.exec(url.pathname);
  if(countSheetMatch!==null)return method==="GET"?readCountSheet(request,Number(countSheetMatch[1]),bindings):methodNotAllowed(request,"GET");
  const batchMatch=/^\/inventory\/count-sheets\/(\d+)\/lines\/batch$/u.exec(url.pathname);
  if(batchMatch!==null)return method==="POST"?patchCountLines(request,Number(batchMatch[1]),bindings):methodNotAllowed(request,"POST");
  const lineMatch=/^\/inventory\/count-sheets\/(\d+)\/lines\/(\d+)$/u.exec(url.pathname);
  if(lineMatch!==null)return method==="PATCH"?patchCountLine(request,Number(lineMatch[1]),Number(lineMatch[2]),bindings):methodNotAllowed(request,"PATCH");
  const approveMatch=/^\/inventory\/count-sheets\/(\d+)\/approve$/u.exec(url.pathname);
  if(approveMatch!==null)return method==="POST"?approveCount(request,Number(approveMatch[1]),bindings):methodNotAllowed(request,"POST");
  const reorderMatch=/^\/inventory\/count-sheets\/(\d+)\/reorder$/u.exec(url.pathname);
  if(reorderMatch!==null)return method==="POST"?reorderCount(request,Number(reorderMatch[1]),bindings):methodNotAllowed(request,"POST");
  const countCsvMatch=/^\/inventory\/count-sheets\/(\d+)\/export\.csv$/u.exec(url.pathname);
  if(countCsvMatch!==null)return method==="GET"?countExport(request,Number(countCsvMatch[1]),"csv",bindings):methodNotAllowed(request,"GET");
  const countXlsxMatch=/^\/inventory\/count-sheets\/(\d+)\/export\.xlsx$/u.exec(url.pathname);
  if(countXlsxMatch!==null)return method==="GET"?countExport(request,Number(countXlsxMatch[1]),"xlsx",bindings):methodNotAllowed(request,"GET");
  const countPrintMatch=/^\/inventory\/count-sheets\/(\d+)\/print$/u.exec(url.pathname);
  if(countPrintMatch!==null)return method==="GET"?countExport(request,Number(countPrintMatch[1]),"print",bindings):methodNotAllowed(request,"GET");
  if (url.pathname === "/inventory/purchase-orders") {
    if (method === "GET") return listPurchaseOrders(request, bindings);
    if (method === "POST") return createOrUpdatePurchaseOrder(request, bindings);
    return methodNotAllowed(request, "GET, POST");
  }
  const purchaseOrderMatch = /^\/inventory\/purchase-orders\/(\d+)$/u.exec(url.pathname);
  if (purchaseOrderMatch !== null) {
    return method === "PUT"
      ? createOrUpdatePurchaseOrder(request, bindings, Number(purchaseOrderMatch[1]))
      : methodNotAllowed(request, "PUT");
  }
  const purchaseOrderStatusMatch = /^\/inventory\/purchase-orders\/(\d+)\/(submit|cancel)$/u.exec(url.pathname);
  if (purchaseOrderStatusMatch !== null) {
    return method === "POST"
      ? changePurchaseOrderStatus(request, Number(purchaseOrderStatusMatch[1]), purchaseOrderStatusMatch[2] === "submit" ? "SUBMITTED" : "CANCELLED", bindings)
      : methodNotAllowed(request, "POST");
  }
  return null;
}
