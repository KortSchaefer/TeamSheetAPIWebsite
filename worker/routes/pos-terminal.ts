import { apiError, jsonResponse, methodNotAllowed, validationError } from "../http";
import type { RuntimeBindings } from "../runtime";
import { hashPassword, verifyPassword } from "../security/passwords";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";
import { configurationBundle, findResolvedPOSButton } from "./pos-configuration";
import {
  booleanValue,
  integerValue,
  iso,
  isObject,
  jsonBody,
  jsonObject,
  jsonText,
  nullableString,
  numberValue,
  randomId,
  requiredString,
  type JsonObject,
} from "./pos-common";

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

interface POSPrincipal {
  sessionId: number;
  credentialId: number;
  employeeId: number;
  employeeName: string;
  accessRole: "SERVER" | "MANAGER";
  expiresAt: string;
}

const POS_COOKIE = "tss_pos_session";
const POS_CATEGORIES = ["Drinks", "Apps", "Apps as Meal", "Salads", "Steaks", "Chicken", "Ribs", "Combos", "Prime", "Special", "Seafood"];
const encoder = new TextEncoder();

function environmentNumber(bindings: RuntimeBindings, name: keyof RuntimeBindings, fallback: number): number {
  const value = bindings[name];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function employeeName(row: Row): string {
  const nickname = nullableString(row.nickname);
  return nickname ?? `${String(row.first_name ?? "")} ${String(row.last_name ?? "")}`.trim();
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, encoder.encode(value)));
}

async function sha256Hex(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

function tokenFromCookie(request: Request): string | null {
  for (const value of (request.headers.get("Cookie") ?? "").split(";")) {
    const separator = value.indexOf("=");
    if (separator >= 0 && value.slice(0, separator).trim() === POS_COOKIE) return value.slice(separator + 1).trim();
  }
  return null;
}

function cookie(request: Request, token: string, maxAge: number): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${POS_COOKIE}=${token}; HttpOnly; Max-Age=${maxAge}; Path=/; SameSite=Strict${secure}`;
}

function clearCookie(request: Request): string {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${POS_COOKIE}=""; expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; Path=/; SameSite=Strict${secure}`;
}

function timestamp(value: unknown): number {
  if (typeof value !== "string") return 0;
  return Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
}

async function posPrincipal(request: Request, bindings: RuntimeBindings): Promise<POSPrincipal | Response> {
  const token = tokenFromCookie(request);
  if (token === null) return apiError(request, 401, "POS session is locked");
  const row = await bindings.database.prepare(
    `SELECT s.id AS session_id,s.credential_id,s.last_seen_at,s.expires_at,s.revoked_at,
      c.active AS credential_active,c.access_role,e.id AS employee_id,e.first_name,e.last_name,e.nickname,e.active AS employee_active
     FROM pos_terminal_sessions s JOIN pos_credentials c ON c.id=s.credential_id
     JOIN employees e ON e.id=c.employee_id WHERE s.token_hash=? LIMIT 1`,
  ).bind(await sha256Hex(token)).first<Row>();
  if (row === null) return apiError(request, 401, "POS session is locked");
  const now = Date.now();
  const idle = environmentNumber(bindings, "posIdleTimeoutSeconds", 45) * 1000;
  const invalid = row.revoked_at !== null || timestamp(row.expires_at) <= now || timestamp(row.last_seen_at) + idle <= now ||
    !booleanValue(row.credential_active) || !booleanValue(row.employee_active);
  if (invalid) {
    if (row.revoked_at === null) await bindings.database.prepare("UPDATE pos_terminal_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE id=?").bind(numberValue(row.session_id)).run();
    return apiError(request, 401, "POS session is locked");
  }
  await bindings.database.prepare("UPDATE pos_terminal_sessions SET last_seen_at=CURRENT_TIMESTAMP WHERE id=?").bind(numberValue(row.session_id)).run();
  return {
    sessionId: numberValue(row.session_id), credentialId: numberValue(row.credential_id), employeeId: numberValue(row.employee_id),
    employeeName: employeeName(row), accessRole: String(row.access_role) === "MANAGER" ? "MANAGER" : "SERVER",
    expiresAt: iso(String(row.expires_at)) as string,
  };
}

function sessionPayload(principal: POSPrincipal, bindings: RuntimeBindings): JsonObject {
  return {
    employee: { employee_id: principal.employeeId, employee_name: principal.employeeName, access_role: principal.accessRole },
    idle_timeout_seconds: environmentNumber(bindings, "posIdleTimeoutSeconds", 45), expires_at: principal.expiresAt,
  };
}

async function ensureCategories(database: D1Database): Promise<Row[]> {
  const existing = (await database.prepare("SELECT * FROM menu_categories").all<Row>()).results;
  const byName = new Map(existing.map((row) => [String(row.name), row]));
  const statements: D1PreparedStatement[] = [];
  POS_CATEGORIES.forEach((name, index) => {
    const row = byName.get(name);
    if (row === undefined) {
      const created: Row = { id: randomId(), name, description: "POS V1 category", active: 1, display_order: index + 1 };
      byName.set(name, created);
      statements.push(database.prepare("INSERT INTO menu_categories(id,name,description,active,display_order) VALUES(?,?,?,1,?)")
        .bind(numberValue(created.id), name, "POS V1 category", index + 1));
    } else if (numberValue(row.display_order) !== index + 1 || !booleanValue(row.active)) {
      row.display_order = index + 1; row.active = 1;
      statements.push(database.prepare("UPDATE menu_categories SET active=1,display_order=? WHERE id=?").bind(index + 1, numberValue(row.id)));
    }
  });
  if (statements.length > 0) await database.batch(statements);
  return [...byName.values()].filter((row) => POS_CATEGORIES.includes(String(row.name))).sort((a, b) => numberValue(a.display_order) - numberValue(b.display_order));
}

function serializeCategory(row: Row): JsonObject {
  return { name: String(row.name), description: row.description ?? null, active: booleanValue(row.active), display_order: numberValue(row.display_order), id: numberValue(row.id) };
}

function serializeMenuItem(row: Row): JsonObject {
  return { name: String(row.name), category_id: row.category_id === null ? null : numberValue(row.category_id), price_cents: numberValue(row.price_cents), active: booleanValue(row.active), id: numberValue(row.id) };
}

async function serializeCheck(database: D1Database, row: Row): Promise<JsonObject> {
  const itemRows = (await database.prepare(
    `SELECT oi.*,mi.name AS menu_name FROM pos_order_items oi JOIN menu_items mi ON mi.id=oi.menu_item_id
     WHERE oi.order_id=? ORDER BY oi.id`,
  ).bind(numberValue(row.id)).all<Row>()).results;
  return {
    id: numberValue(row.id), check_number: numberValue(row.check_number, 1), status: String(row.status), progress: String(row.progress),
    subtotal_cents: numberValue(row.subtotal_cents), tax_cents: numberValue(row.tax_cents), tip_cents: numberValue(row.tip_cents),
    total_cents: numberValue(row.total_cents), print_count: numberValue(row.print_count),
    printed_at: row.printed_at === null ? null : iso(String(row.printed_at)), closed_at: row.closed_at === null ? null : iso(String(row.closed_at)),
    item_count: itemRows.reduce((sum, item) => sum + numberValue(item.quantity), 0),
    items: itemRows.map((item) => ({ id: numberValue(item.id), menu_item_id: numberValue(item.menu_item_id),
      display_name: String(item.display_name_snapshot ?? item.menu_name), quantity: numberValue(item.quantity), price_cents: numberValue(item.price_cents),
      modifier_total_cents: numberValue(item.modifier_total_cents), configuration: jsonObject(item.configuration_snapshot) })),
  };
}

async function currentCheckRow(database: D1Database, tableId: number): Promise<Row | null> {
  return database.prepare(
    `SELECT * FROM pos_orders WHERE table_id=? ORDER BY CASE WHEN status='OPEN' THEN 0 ELSE 1 END,check_number DESC,id DESC LIMIT 1`,
  ).bind(tableId).first<Row>();
}

async function serializeTable(database: D1Database, tableId: number): Promise<JsonObject | null> {
  const row = await database.prepare(
    `SELECT t.*,e.first_name,e.last_name,e.nickname FROM pos_tables t JOIN employees e ON e.id=t.owner_employee_id WHERE t.id=?`,
  ).bind(tableId).first<Row>();
  if (row === null) return null;
  const check = await currentCheckRow(database, tableId);
  if (check === null) throw new Error("Table does not have a check");
  return {
    id: numberValue(row.id), table_number: numberValue(row.table_number), owner_employee_id: numberValue(row.owner_employee_id),
    owner_name: employeeName(row), status: String(row.status), progress: String(row.progress), revision: numberValue(row.revision),
    opened_at: iso(String(row.opened_at)), closed_at: row.closed_at === null ? null : iso(String(row.closed_at)),
    check: await serializeCheck(database, check),
  };
}

async function accessibleTable(
  request: Request,
  bindings: RuntimeBindings,
  principal: POSPrincipal,
  tableId: number,
  includeClosed = false,
): Promise<Row | Response> {
  const row = await bindings.database.prepare("SELECT * FROM pos_tables WHERE id=?").bind(tableId).first<Row>();
  if (row === null || (!includeClosed && row.status !== "OPEN")) return apiError(request, 404, "POS table not found");
  if (principal.accessRole !== "MANAGER" && numberValue(row.owner_employee_id) !== principal.employeeId) return apiError(request, 403, "This table belongs to another server");
  return row;
}

async function tableForCheck(
  request: Request,
  bindings: RuntimeBindings,
  principal: POSPrincipal,
  checkId: number,
  includeClosed = false,
): Promise<{ table: Row; check: Row } | Response> {
  const check = await bindings.database.prepare("SELECT * FROM pos_orders WHERE id=?").bind(checkId).first<Row>();
  if (check === null || check.table_id === null) return apiError(request, 404, "POS check not found");
  const table = await accessibleTable(request, bindings, principal, numberValue(check.table_id), includeClosed);
  if (table instanceof Response) return table;
  const current = await currentCheckRow(bindings.database, numberValue(table.id));
  if (current === null || numberValue(current.id) !== checkId) return apiError(request, 404, "POS check not found");
  return { table, check: current };
}

async function requireApplicationUser(request: Request, bindings: RuntimeBindings, manager = false) {
  const auth = await authenticateRequest(request, bindings);
  if (auth.response !== null || auth.user === null) return auth;
  if (!manager) return auth;
  const denied = requireManagerOrAdmin(request, auth.user.role);
  return denied === null ? auth : { user: null, response: denied };
}

async function menuRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (url.pathname === "/pos/menu-categories") {
    const auth = await requireApplicationUser(request, bindings, request.method === "POST");
    if (auth.response !== null) return auth.response;
    if (request.method === "GET") {
      const result = await bindings.database.prepare("SELECT * FROM menu_categories ORDER BY display_order,name").all<Row>();
      return jsonResponse(request, result.results.map(serializeCategory));
    }
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const name = requiredString(request, body, "name", 100);
    if (name instanceof Response) return name;
    const id = randomId();
    try {
      await bindings.database.prepare("INSERT INTO menu_categories(id,name,description,active,display_order) VALUES(?,?,?,?,?)")
        .bind(id, name, nullableString(body.description), booleanValue(body.active) ? 1 : 0, Math.max(0, integerValue(body.display_order))).run();
    } catch (error) {
      return error instanceof Error && /unique|constraint/iu.test(error.message) ? apiError(request, 409, "Menu category already exists") : apiError(request, 500, "Internal Server Error");
    }
    return jsonResponse(request, { name, description: nullableString(body.description), active: booleanValue(body.active), display_order: Math.max(0, integerValue(body.display_order)), id }, { status: 201 });
  }
  if (url.pathname === "/pos/menu-items") {
    const auth = await requireApplicationUser(request, bindings, request.method === "POST");
    if (auth.response !== null) return auth.response;
    if (request.method === "GET") {
      const active = url.searchParams.get("active");
      const statement = active === null
        ? bindings.database.prepare("SELECT * FROM menu_items ORDER BY name")
        : bindings.database.prepare("SELECT * FROM menu_items WHERE active=? ORDER BY name").bind(active === "true" ? 1 : 0);
      const result = await statement.all<Row>();
      return jsonResponse(request, result.results.map(serializeMenuItem));
    }
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const name = requiredString(request, body, "name", 150);
    if (name instanceof Response) return name;
    const categoryId = body.category_id === null || body.category_id === undefined ? null : integerValue(body.category_id);
    if (categoryId !== null && (await bindings.database.prepare("SELECT id FROM menu_categories WHERE id=?").bind(categoryId).first()) === null) return apiError(request, 404, "Menu category not found");
    const id = randomId(), priceCents = Math.max(0, integerValue(body.price_cents)), active = booleanValue(body.active);
    await bindings.database.prepare("INSERT INTO menu_items(id,category_id,name,price_cents,active) VALUES(?,?,?,?,?)")
      .bind(id, categoryId, name, priceCents, active ? 1 : 0).run();
    return jsonResponse(request, { name, category_id: categoryId, price_cents: priceCents, active, id }, { status: 201 });
  }
  return null;
}

async function serializeOrder(database: D1Database, orderId: number): Promise<JsonObject | null> {
  const row = await database.prepare("SELECT * FROM pos_orders WHERE id=?").bind(orderId).first<Row>();
  if (row === null) return null;
  const result = await database.prepare("SELECT * FROM pos_order_items WHERE order_id=? ORDER BY id").bind(orderId).all<Row>();
  return {
    created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), shift_id: row.shift_id === null ? null : numberValue(row.shift_id),
    server_id: row.server_id === null ? null : numberValue(row.server_id), table_label: row.table_label ?? null, notes: row.notes ?? null,
    id: numberValue(row.id), status: String(row.status),
    items: result.results.map((item) => ({ created_at: iso(String(item.created_at)), updated_at: iso(String(item.updated_at)),
      menu_item_id: numberValue(item.menu_item_id), quantity: numberValue(item.quantity), price_cents: numberValue(item.price_cents), id: numberValue(item.id) })),
  };
}

async function recordRecipeSale(database: D1Database, orderItem: Row): Promise<void> {
  const recipes = (await database.prepare("SELECT * FROM recipe_items WHERE menu_item_id=?").bind(numberValue(orderItem.menu_item_id)).all<Row>()).results;
  for (const recipe of recipes) {
    const sourceKey = `pos-order-item:${numberValue(orderItem.id)}:ingredient:${numberValue(recipe.ingredient_id)}`;
    if ((await database.prepare("SELECT id FROM stock_movements WHERE source_event_key=?").bind(sourceKey).first()) !== null) continue;
    const inventory = await database.prepare("SELECT * FROM inventory_items WHERE ingredient_id=? AND active=1 LIMIT 1").bind(numberValue(recipe.ingredient_id)).first<Row>();
    const quantity = -(numberValue(recipe.quantity, 1) * numberValue(orderItem.quantity, 1));
    const statements: D1PreparedStatement[] = [];
    let locationId: number | null = null;
    if (inventory !== null && inventory.default_location_id !== null) {
      locationId = numberValue(inventory.default_location_id);
      statements.push(database.prepare(
        `INSERT INTO inventory_balances(id,inventory_item_id,location_id,quantity_on_hand,minimum_quantity,par_quantity,maximum_quantity,planning_active,created_at,updated_at)
         VALUES(?,?,?, ?,0,0,NULL,1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)
         ON CONFLICT(inventory_item_id,location_id) DO UPDATE SET quantity_on_hand=quantity_on_hand+excluded.quantity_on_hand,updated_at=CURRENT_TIMESTAMP`,
      ).bind(randomId(), numberValue(inventory.id), locationId, quantity));
    }
    statements.push(database.prepare(
      `INSERT INTO stock_movements(id,ingredient_id,inventory_item_id,location_id,quantity_change,reason,order_item_id,source_event_key,
       created_by_user_id,lot_number,expiration_date,notes,created_at,updated_at)
       VALUES(?,?,?,?,?,'SALE',?,?,NULL,NULL,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(randomId(), numberValue(recipe.ingredient_id), inventory === null ? null : numberValue(inventory.id), locationId, quantity, numberValue(orderItem.id), sourceKey));
    await database.batch(statements);
  }
}

async function orderRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (url.pathname === "/pos/orders") {
    const auth = await requireApplicationUser(request, bindings);
    if (auth.response !== null) return auth.response;
    if (request.method === "GET") {
      const status = url.searchParams.get("status_filter");
      const result = status === null
        ? await bindings.database.prepare("SELECT id FROM pos_orders ORDER BY created_at DESC").all<{ id: number }>()
        : await bindings.database.prepare("SELECT id FROM pos_orders WHERE status=? ORDER BY created_at DESC").bind(status).all<{ id: number }>();
      return jsonResponse(request, await Promise.all(result.results.map((row) => serializeOrder(bindings.database, row.id))));
    }
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const id = randomId();
    await bindings.database.prepare(
      `INSERT INTO pos_orders(id,status,shift_id,server_id,table_id,check_number,progress,subtotal_cents,tax_cents,tip_cents,total_cents,
       print_count,printed_at,closed_at,table_label,notes,created_at,updated_at)
       VALUES(?,'OPEN',?,?,NULL,1,'FOOD_UNORDERED',0,0,0,0,0,NULL,NULL,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(id, body.shift_id === null || body.shift_id === undefined ? null : integerValue(body.shift_id),
      body.server_id === null || body.server_id === undefined ? null : integerValue(body.server_id), nullableString(body.table_label), nullableString(body.notes)).run();
    return jsonResponse(request, await serializeOrder(bindings.database, id), { status: 201 });
  }
  let match = /^\/pos\/orders\/(\d+)\/items$/u.exec(url.pathname);
  if (match !== null) {
    if (request.method !== "POST") return methodNotAllowed(request, "POST");
    const auth = await requireApplicationUser(request, bindings);
    if (auth.response !== null) return auth.response;
    const orderId = Number(match[1]);
    const order = await bindings.database.prepare("SELECT * FROM pos_orders WHERE id=?").bind(orderId).first<Row>();
    if (order === null) return apiError(request, 404, "Order not found");
    if (order.status !== "OPEN") return apiError(request, 400, "Order is not open");
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const menuItem = await bindings.database.prepare("SELECT * FROM menu_items WHERE id=?").bind(integerValue(body.menu_item_id)).first<Row>();
    if (menuItem === null) return apiError(request, 404, "Menu item not found");
    const id = randomId(), quantity = Math.max(1, integerValue(body.quantity, 1));
    const requestedPrice = integerValue(body.price_cents), price = requestedPrice || numberValue(menuItem.price_cents);
    await bindings.database.prepare(
      `INSERT INTO pos_order_items(id,order_id,menu_item_id,quantity,price_cents,modifier_total_cents,display_name_snapshot,configuration_snapshot,created_at,updated_at)
       VALUES(?,?,?,?,?,0,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(id, orderId, numberValue(menuItem.id), quantity, price).run();
    const row = await bindings.database.prepare("SELECT * FROM pos_order_items WHERE id=?").bind(id).first<Row>();
    return jsonResponse(request, { created_at: iso(String(row?.created_at)), updated_at: iso(String(row?.updated_at)), menu_item_id: numberValue(menuItem.id), quantity, price_cents: price, id }, { status: 201 });
  }
  match = /^\/pos\/orders\/(\d+)\/close$/u.exec(url.pathname);
  if (match !== null) {
    if (request.method !== "POST") return methodNotAllowed(request, "POST");
    const auth = await requireApplicationUser(request, bindings, true);
    if (auth.response !== null) return auth.response;
    const orderId = Number(match[1]);
    const order = await bindings.database.prepare("SELECT * FROM pos_orders WHERE id=?").bind(orderId).first<Row>();
    if (order === null) return apiError(request, 404, "Order not found");
    if (order.status !== "OPEN") return apiError(request, 400, "Order already closed");
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const payment = isObject(body.payment) ? body.payment : {};
    const items = (await bindings.database.prepare("SELECT * FROM pos_order_items WHERE order_id=?").bind(orderId).all<Row>()).results;
    for (const item of items) await recordRecipeSale(bindings.database, item);
    await bindings.database.batch([
      bindings.database.prepare("INSERT INTO pos_payments(id,order_id,amount_cents,method,created_at,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
        .bind(randomId(), orderId, Math.max(0, integerValue(payment.amount_cents)), String(payment.method ?? "CARD")),
      bindings.database.prepare("UPDATE pos_orders SET status='CLOSED',closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(orderId),
    ]);
    return jsonResponse(request, await serializeOrder(bindings.database, orderId));
  }
  return null;
}

function serializeAccess(row: Row): JsonObject {
  return {
    employee_id: numberValue(row.id), employee_name: employeeName(row), employee_role: String(row.role),
    access_role: row.access_role ?? null, pos_active: row.credential_id !== null && booleanValue(row.credential_active),
    has_employee_number: row.credential_id !== null, last_used_at: row.last_used_at === null ? null : iso(String(row.last_used_at)),
    locked_until: row.locked_until === null ? null : iso(String(row.locked_until)),
  };
}

async function accessRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/pos/admin/access")) return null;
  const auth = await requireApplicationUser(request, bindings, true);
  if (auth.response !== null) return auth.response;
  if (url.pathname === "/pos/admin/access") {
    if (request.method !== "GET") return methodNotAllowed(request, "GET");
    const result = await bindings.database.prepare(
      `SELECT e.*,c.id AS credential_id,c.access_role,c.active AS credential_active,c.last_used_at,c.locked_until
       FROM employees e LEFT JOIN pos_credentials c ON c.employee_id=e.id ORDER BY e.first_name,e.last_name`,
    ).all<Row>();
    return jsonResponse(request, result.results.map(serializeAccess));
  }
  const match = /^\/pos\/admin\/access\/(\d+)$/u.exec(url.pathname);
  if (match === null) return apiError(request, 404, "Not Found");
  if (request.method !== "PUT") return methodNotAllowed(request, "PUT");
  const employeeId = Number(match[1]);
  const employee = await bindings.database.prepare("SELECT * FROM employees WHERE id=?").bind(employeeId).first<Row>();
  if (employee === null) return apiError(request, 404, "Employee not found");
  const body = await jsonBody(request);
  if (body instanceof Response) return body;
  const employeeNumber = body.employee_number === null || body.employee_number === undefined ? null : String(body.employee_number);
  if (employeeNumber !== null && !/^\d{4,6}$/u.test(employeeNumber)) return validationError(request, [{ type: "string_pattern_mismatch", loc: ["body", "employee_number"], msg: "String should match pattern", input: employeeNumber }]);
  const accessRole = String(body.access_role ?? "SERVER");
  if (accessRole !== "SERVER" && accessRole !== "MANAGER") return validationError(request, [{ type: "enum", loc: ["body", "access_role"], msg: "Input should be 'SERVER' or 'MANAGER'", input: accessRole }]);
  const existing = await bindings.database.prepare("SELECT * FROM pos_credentials WHERE employee_id=?").bind(employeeId).first<Row>();
  if (existing === null && employeeNumber === null) return apiError(request, 422, "An employee number is required when enabling POS access");
  let lookup: string | null = null, passwordHash: string | null = null;
  if (employeeNumber !== null) {
    lookup = await hmacHex(bindings.secretKey, employeeNumber);
    const duplicate = await bindings.database.prepare("SELECT employee_id FROM pos_credentials WHERE pin_lookup_digest=? AND employee_id<>?").bind(lookup, employeeId).first();
    if (duplicate !== null) return apiError(request, 409, "That employee number is already assigned");
    passwordHash = await hashPassword(employeeNumber);
  }
  const credentialId = existing === null ? randomId() : numberValue(existing.id);
  const statements: D1PreparedStatement[] = [];
  if (existing === null) statements.push(bindings.database.prepare(
    `INSERT INTO pos_credentials(id,employee_id,pin_lookup_digest,pin_hash,access_role,active,failed_attempts,locked_until,last_used_at,created_at,updated_at)
     VALUES(?,?,?,?,?,?,0,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  ).bind(credentialId, employeeId, lookup, passwordHash, accessRole, booleanValue(body.active) ? 1 : 0));
  else statements.push(employeeNumber === null
    ? bindings.database.prepare("UPDATE pos_credentials SET access_role=?,active=?,failed_attempts=0,locked_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(accessRole, booleanValue(body.active) ? 1 : 0, credentialId)
    : bindings.database.prepare("UPDATE pos_credentials SET pin_lookup_digest=?,pin_hash=?,access_role=?,active=?,failed_attempts=0,locked_until=NULL,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(lookup, passwordHash, accessRole, booleanValue(body.active) ? 1 : 0, credentialId));
  statements.push(bindings.database.prepare("UPDATE pos_terminal_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE credential_id=? AND revoked_at IS NULL").bind(credentialId));
  await bindings.database.batch(statements);
  const result = await bindings.database.prepare(
    `SELECT e.*,c.id AS credential_id,c.access_role,c.active AS credential_active,c.last_used_at,c.locked_until
     FROM employees e LEFT JOIN pos_credentials c ON c.employee_id=e.id WHERE e.id=?`,
  ).bind(employeeId).first<Row>();
  return jsonResponse(request, serializeAccess(result as Row));
}

async function pinRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/pos/pin/")) return null;
  if (url.pathname === "/pos/pin/login") {
    if (request.method !== "POST") return methodNotAllowed(request, "POST");
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const number = String(body.employee_number ?? "");
    if (!/^\d{4,6}$/u.test(number)) return validationError(request, [{ type: "string_pattern_mismatch", loc: ["body", "employee_number"], msg: "String should match pattern", input: number }]);
    const lookup = await hmacHex(bindings.secretKey, number);
    const credential = await bindings.database.prepare(
      `SELECT c.*,e.id AS employee_id,e.first_name,e.last_name,e.nickname,e.active AS employee_active
       FROM pos_credentials c JOIN employees e ON e.id=c.employee_id WHERE c.pin_lookup_digest=? LIMIT 1`,
    ).bind(lookup).first<Row>();
    const now = Date.now();
    const invalid = credential === null || !booleanValue(credential.active) || !booleanValue(credential.employee_active) ||
      (credential.locked_until !== null && timestamp(credential.locked_until) > now);
    if (invalid) return apiError(request, 401, "Employee number was not recognized");
    if (!(await verifyPassword(number, String(credential.pin_hash)))) {
      const attempts = numberValue(credential.failed_attempts) + 1;
      const max = environmentNumber(bindings, "posLoginMaxAttempts", 5);
      if (attempts >= max) await bindings.database.prepare(
        `UPDATE pos_credentials SET failed_attempts=0,locked_until=datetime('now',?),updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      ).bind(`+${environmentNumber(bindings, "posLoginLockMinutes", 5)} minutes`, numberValue(credential.id)).run();
      else await bindings.database.prepare("UPDATE pos_credentials SET failed_attempts=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(attempts, numberValue(credential.id)).run();
      return apiError(request, 401, "Employee number was not recognized");
    }
    const rawToken = `${crypto.randomUUID()}${crypto.randomUUID()}`.replaceAll("-", "");
    const hours = environmentNumber(bindings, "posSessionExpireHours", 12), sessionId = randomId();
    await bindings.database.batch([
      bindings.database.prepare("UPDATE pos_credentials SET failed_attempts=0,locked_until=NULL,last_used_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(numberValue(credential.id)),
      bindings.database.prepare(
        `INSERT INTO pos_terminal_sessions(id,credential_id,token_hash,issued_at,last_seen_at,expires_at,revoked_at)
         VALUES(?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP,datetime('now',?),NULL)`,
      ).bind(sessionId, numberValue(credential.id), await sha256Hex(rawToken), `+${hours} hours`),
    ]);
    const session = await bindings.database.prepare("SELECT expires_at FROM pos_terminal_sessions WHERE id=?").bind(sessionId).first<Row>();
    const principal: POSPrincipal = { sessionId, credentialId: numberValue(credential.id), employeeId: numberValue(credential.employee_id),
      employeeName: employeeName(credential), accessRole: credential.access_role === "MANAGER" ? "MANAGER" : "SERVER", expiresAt: iso(String(session?.expires_at)) as string };
    return jsonResponse(request, sessionPayload(principal, bindings), { headers: { "Set-Cookie": cookie(request, rawToken, hours * 3600) } });
  }
  if (url.pathname === "/pos/pin/logout") {
    if (request.method !== "POST") return methodNotAllowed(request, "POST");
    const token = tokenFromCookie(request);
    if (token !== null) await bindings.database.prepare("UPDATE pos_terminal_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE token_hash=? AND revoked_at IS NULL").bind(await sha256Hex(token)).run();
    return new Response(null, { status: 204, headers: { "Set-Cookie": clearCookie(request) } });
  }
  if (url.pathname === "/pos/pin/session") {
    if (request.method !== "GET") return methodNotAllowed(request, "GET");
    const principal = await posPrincipal(request, bindings);
    return principal instanceof Response ? principal : jsonResponse(request, sessionPayload(principal, bindings));
  }
  return apiError(request, 404, "Not Found");
}

async function tableList(bindings: RuntimeBindings, principal: POSPrincipal): Promise<JsonObject[]> {
  const result = principal.accessRole === "MANAGER"
    ? await bindings.database.prepare("SELECT id FROM pos_tables WHERE status='OPEN' ORDER BY table_number").all<{ id: number }>()
    : await bindings.database.prepare("SELECT id FROM pos_tables WHERE status='OPEN' AND owner_employee_id=? ORDER BY table_number").bind(principal.employeeId).all<{ id: number }>();
  return (await Promise.all(result.results.map((row) => serializeTable(bindings.database, row.id)))).filter((value): value is JsonObject => value !== null);
}

async function transferCandidates(database: D1Database): Promise<JsonObject[]> {
  const result = await database.prepare(
    `SELECT e.id AS employee_id,e.first_name,e.last_name,e.nickname,c.access_role
     FROM pos_credentials c JOIN employees e ON e.id=c.employee_id
     WHERE c.active=1 AND c.access_role='SERVER' AND e.active=1 ORDER BY e.first_name,e.last_name`,
  ).all<Row>();
  return result.results.map((row) => ({ employee_id: numberValue(row.employee_id), employee_name: employeeName(row), access_role: "SERVER" }));
}

async function createTable(request: Request, body: JsonObject, bindings: RuntimeBindings, principal: POSPrincipal): Promise<Response> {
  const tableNumber = integerValue(body.table_number);
  if (tableNumber < 1 || tableNumber > 9999) return validationError(request, [{ type: "less_than_equal", loc: ["body", "table_number"], msg: "Input should be between 1 and 9999", input: body.table_number }]);
  const clientId = typeof body.client_request_id === "string" ? body.client_request_id : "";
  if (clientId.length < 8 || clientId.length > 64) return validationError(request, [{ type: "string_too_short", loc: ["body", "client_request_id"], msg: "String should have at least 8 characters", input: clientId }]);
  const repeated = await bindings.database.prepare("SELECT * FROM pos_tables WHERE client_request_id=?").bind(clientId).first<Row>();
  if (repeated !== null) {
    if (principal.accessRole !== "MANAGER" && numberValue(repeated.owner_employee_id) !== principal.employeeId) return apiError(request, 403, "Request belongs to another server");
    return jsonResponse(request, await serializeTable(bindings.database, numberValue(repeated.id)), { status: 201 });
  }
  if ((await bindings.database.prepare("SELECT id FROM pos_tables WHERE active_number_key=?").bind(String(tableNumber)).first()) !== null) return apiError(request, 409, "That table is already open");
  const tableId = randomId(), checkId = randomId();
  try {
    await bindings.database.batch([
      bindings.database.prepare(
        `INSERT INTO pos_tables(id,table_number,client_request_id,active_number_key,owner_employee_id,status,progress,revision,opened_at,closed_at,created_at,updated_at)
         VALUES(?,?,?,?,?,'OPEN','FOOD_UNORDERED',1,CURRENT_TIMESTAMP,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      ).bind(tableId, tableNumber, clientId, String(tableNumber), principal.employeeId),
      bindings.database.prepare(
        `INSERT INTO pos_orders(id,status,shift_id,server_id,table_id,check_number,progress,subtotal_cents,tax_cents,tip_cents,total_cents,
         print_count,printed_at,closed_at,table_label,notes,created_at,updated_at)
         VALUES(?,'OPEN',NULL,?,?,1,'FOOD_UNORDERED',0,0,0,0,0,NULL,NULL,?,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
      ).bind(checkId, principal.employeeId, tableId, String(tableNumber)),
      bindings.database.prepare(
        `INSERT INTO pos_table_events(id,table_id,order_id,employee_id,event_type,details,created_at)
         VALUES(?,?,?,?,'TABLE_OPENED',?,CURRENT_TIMESTAMP)`,
      ).bind(randomId(), tableId, checkId, principal.employeeId, jsonText({ table_number: tableNumber })),
    ]);
  } catch (error) {
    if (error instanceof Error && /unique|constraint/iu.test(error.message)) return apiError(request, 409, "That table is already open");
    throw error;
  }
  return jsonResponse(request, await serializeTable(bindings.database, tableId), { status: 201 });
}

async function transferTable(request: Request, tableId: number, body: JsonObject, bindings: RuntimeBindings, principal: POSPrincipal): Promise<Response> {
  if (principal.accessRole !== "MANAGER") return apiError(request, 403, "Manager POS access is required");
  const table = await accessibleTable(request, bindings, principal, tableId);
  if (table instanceof Response) return table;
  const revision = integerValue(body.revision), ownerId = integerValue(body.owner_employee_id);
  if (numberValue(table.revision) !== revision) return apiError(request, 409, "Table changed; refresh and try again");
  const target = await bindings.database.prepare(
    `SELECT c.id FROM pos_credentials c JOIN employees e ON e.id=c.employee_id
     WHERE c.employee_id=? AND c.active=1 AND c.access_role='SERVER' AND e.active=1`,
  ).bind(ownerId).first();
  if (target === null) return apiError(request, 422, "Choose an active POS server");
  const check = await currentCheckRow(bindings.database, tableId);
  if (check === null) return apiError(request, 409, "Table does not have a check");
  await bindings.database.batch([
    bindings.database.prepare("UPDATE pos_tables SET owner_employee_id=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=?").bind(ownerId, tableId, revision),
    bindings.database.prepare("UPDATE pos_orders SET server_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(ownerId, numberValue(check.id)),
    bindings.database.prepare(
      `INSERT INTO pos_table_events(id,table_id,order_id,employee_id,event_type,details,created_at)
       VALUES(?,?,?,?,'TABLE_TRANSFERRED',?,CURRENT_TIMESTAMP)`,
    ).bind(randomId(), tableId, numberValue(check.id), principal.employeeId,
      jsonText({ previous_owner_employee_id: numberValue(table.owner_employee_id), owner_employee_id: ownerId })),
  ]);
  return jsonResponse(request, await serializeTable(bindings.database, tableId));
}

function validateSelections(button: JsonObject, raw: unknown): { total: number; snapshot: JsonObject[] } | string {
  const selections = Array.isArray(raw) ? raw.filter(isObject).map((value) => ({ modifier_id: integerValue(value.modifier_id), quantity: Math.max(1, integerValue(value.quantity, 1)) })) : [];
  const quantities = new Map(selections.map((value) => [value.modifier_id, value.quantity]));
  const selected = new Set(quantities.keys()), allowed = new Set<number>();
  let total = 0;
  const snapshot: JsonObject[] = [];
  const groups = Array.isArray(button.modifier_groups) ? button.modifier_groups.filter(isObject) : [];
  for (const group of groups) {
    const options = new Map((Array.isArray(group.modifiers) ? group.modifiers.filter(isObject) : []).filter((value) => booleanValue(value.active)).map((value) => [integerValue(value.id), value]));
    for (const id of options.keys()) allowed.add(id);
    const selectedIds = [...selected].filter((id) => options.has(id));
    const allowQuantities = booleanValue(group.allow_quantities, false);
    const count = selectedIds.reduce((sum, id) => sum + (allowQuantities ? (quantities.get(id) ?? 1) : 1), 0);
    const minimum = Math.max(booleanValue(group.required, false) ? 1 : 0, integerValue(group.minimum_selections));
    const maximum = Math.max(1, integerValue(group.maximum_selections, 1));
    if (count < minimum || count > maximum) return `${String(group.name)} requires ${minimum} to ${maximum} selections`;
    for (const id of selectedIds) {
      const option = options.get(id) as JsonObject, quantity = quantities.get(id) ?? 1;
      if (quantity > 1 && !allowQuantities) return `${String(group.name)} does not allow modifier quantities`;
      total += integerValue(option.price_delta_cents) * quantity;
      snapshot.push({ modifier_id: id, group_id: integerValue(group.id), group_name: String(group.name), name: String(option.name), quantity, price_delta_cents: integerValue(option.price_delta_cents) });
    }
  }
  const unknown = [...selected].filter((id) => !allowed.has(id)).sort((a, b) => a - b);
  return unknown.length > 0 ? `Invalid modifier selection: ${unknown[0]}` : { total, snapshot };
}

async function addConfiguredItem(request: Request, checkId: number, body: JsonObject, bindings: RuntimeBindings, principal: POSPrincipal): Promise<Response> {
  const target = await tableForCheck(request, bindings, principal, checkId);
  if (target instanceof Response) return target;
  const button = await findResolvedPOSButton(bindings.database, integerValue(body.button_id));
  if (button === null) return apiError(request, 404, "POS button not found");
  const validated = validateSelections(button, body.modifiers);
  if (typeof validated === "string") return apiError(request, 422, validated);
  const quantity = Math.min(99, Math.max(1, integerValue(body.quantity, 1))), itemId = randomId();
  const price = integerValue(button.price_cents), amount = (price + validated.total) * quantity;
  const snapshot = { button_id: integerValue(button.id), button_revision: integerValue(button.revision), modifiers: validated.snapshot, notes: nullableString(body.notes) };
  await bindings.database.batch([
    bindings.database.prepare(
      `INSERT INTO pos_order_items(id,order_id,menu_item_id,quantity,price_cents,modifier_total_cents,display_name_snapshot,configuration_snapshot,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(itemId, checkId, integerValue(button.menu_item_id), quantity, price, validated.total, String(button.display_name), jsonText(snapshot)),
    bindings.database.prepare(
      `UPDATE pos_orders SET subtotal_cents=subtotal_cents+?,total_cents=subtotal_cents+?+tax_cents+tip_cents,
       progress='FOOD_ORDERED',updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(amount, amount, checkId),
    bindings.database.prepare("UPDATE pos_tables SET progress='FOOD_ORDERED',revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .bind(numberValue(target.table.id)),
  ]);
  const serialized = await serializeTable(bindings.database, numberValue(target.table.id));
  return jsonResponse(request, { id: itemId, display_name: String(button.display_name), quantity, price_cents: price,
    modifier_total_cents: validated.total, configuration: snapshot, check: serialized?.check, table_revision: serialized?.revision }, { status: 201 });
}

function escapeHtml(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

async function printView(request: Request, target: { table: Row; check: Row }, bindings: RuntimeBindings): Promise<Response> {
  const serialized = await serializeTable(bindings.database, numberValue(target.table.id));
  if (serialized === null) return apiError(request, 404, "POS table not found");
  const check = jsonObject(serialized.check), items = Array.isArray(check.items) ? check.items.filter(isObject) : [];
  const itemRows = items.map((item) => `<div class="row"><span>${numberValue(item.quantity)} x ${escapeHtml(item.display_name)}</span><span>$${(((numberValue(item.price_cents) + numberValue(item.modifier_total_cents)) * numberValue(item.quantity)) / 100).toFixed(2)}</span></div>`).join("") || '<p class="center">No menu items</p>';
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Table ${numberValue(serialized.table_number)} Check</title><style>body{font:14px/1.35 ui-monospace,Consolas,monospace;margin:0;color:#111}.receipt{width:72mm;margin:0 auto;padding:8mm 4mm}h1{font-size:22px;text-align:center;margin:0}.center{text-align:center}.rule{border-top:1px dashed #111;margin:12px 0}.row{display:flex;justify-content:space-between;gap:10px}.total{font-size:18px;font-weight:800}@media print{@page{size:80mm auto;margin:0}button{display:none}}</style></head><body><main class="receipt"><h1>Team Sheet POS</h1><p class="center">Training Check</p><div class="rule"></div><div class="row"><span>Table</span><strong>${numberValue(serialized.table_number)}</strong></div><div class="row"><span>Check</span><span>${numberValue(check.check_number)}</span></div><div class="row"><span>Server</span><span>${escapeHtml(serialized.owner_name)}</span></div><div class="row"><span>Opened</span><span>${escapeHtml(serialized.opened_at)}</span></div><div class="rule"></div>${itemRows}<div class="rule"></div><div class="row total"><span>Total</span><span>$${(numberValue(check.total_cents) / 100).toFixed(2)}</span></div><p class="center"><button onclick="window.print()">Print Check</button></p><script>window.addEventListener('load',()=>window.print())</script></main></body></html>`;
  return new Response(request.method === "HEAD" ? null : html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function terminalRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/pos/terminal/")) return null;
  const principal = await posPrincipal(request, bindings);
  if (principal instanceof Response) return principal;
  if (url.pathname === "/pos/terminal/bootstrap") {
    if (request.method !== "GET") return methodNotAllowed(request, "GET");
    const categories = (await ensureCategories(bindings.database)).map(serializeCategory);
    const config = await configurationBundle(bindings.database, { includeDeleted: false, resolve: true });
    return jsonResponse(request, {
      ...sessionPayload(principal, bindings), permissions: { view_all_tables: principal.accessRole === "MANAGER", transfer_tables: principal.accessRole === "MANAGER" },
      features: { menu_items: true, payments: false, tips: false, promos: false, comps: false, checkout: false }, categories,
      tables: await tableList(bindings, principal), transfer_candidates: principal.accessRole === "MANAGER" ? await transferCandidates(bindings.database) : [],
      menu_config: { schema_version: config.schema_version, pages: (config.pages as JsonObject[]).filter((page) => booleanValue(page.active)), buttons: config.buttons },
    });
  }
  if (url.pathname === "/pos/terminal/tables") {
    if (request.method === "GET") return jsonResponse(request, await tableList(bindings, principal));
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request); return body instanceof Response ? body : createTable(request, body, bindings, principal);
  }
  let match = /^\/pos\/terminal\/tables\/(\d+)(?:\/(transfer))?$/u.exec(url.pathname);
  if (match !== null) {
    const tableId = Number(match[1]);
    if (match[2] === "transfer") {
      if (request.method !== "POST") return methodNotAllowed(request, "POST");
      const body = await jsonBody(request); return body instanceof Response ? body : transferTable(request, tableId, body, bindings, principal);
    }
    if (request.method !== "GET") return methodNotAllowed(request, "GET");
    const table = await accessibleTable(request, bindings, principal, tableId);
    return table instanceof Response ? table : jsonResponse(request, await serializeTable(bindings.database, tableId));
  }
  match = /^\/pos\/terminal\/checks\/(\d+)\/(items|print|print-view|close-empty)$/u.exec(url.pathname);
  if (match !== null) {
    const checkId = Number(match[1]), action = match[2];
    if (action === "items") {
      if (request.method !== "POST") return methodNotAllowed(request, "POST");
      const body = await jsonBody(request); return body instanceof Response ? body : addConfiguredItem(request, checkId, body, bindings, principal);
    }
    const target = await tableForCheck(request, bindings, principal, checkId, action === "print-view");
    if (target instanceof Response) return target;
    if (action === "print-view") return request.method === "GET" || request.method === "HEAD" ? printView(request, target, bindings) : methodNotAllowed(request, "GET, HEAD");
    if (request.method !== "POST") return methodNotAllowed(request, "POST");
    if (action === "print") {
      await bindings.database.batch([
        bindings.database.prepare("UPDATE pos_orders SET print_count=print_count+1,printed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(checkId),
        bindings.database.prepare("INSERT INTO pos_table_events(id,table_id,order_id,employee_id,event_type,details,created_at) VALUES(?,?,?,?,'CHECK_PRINTED',?,CURRENT_TIMESTAMP)")
          .bind(randomId(), numberValue(target.table.id), checkId, principal.employeeId, jsonText({ print_count: numberValue(target.check.print_count) + 1 })),
      ]);
      const updated = await bindings.database.prepare("SELECT print_count,printed_at FROM pos_orders WHERE id=?").bind(checkId).first<Row>();
      return jsonResponse(request, { print_url: `/pos/terminal/checks/${checkId}/print-view`, print_count: numberValue(updated?.print_count), printed_at: iso(String(updated?.printed_at)) });
    }
    const body = await jsonBody(request);
    if (body instanceof Response) return body;
    const revision = integerValue(body.revision);
    if (numberValue(target.table.revision) !== revision) return apiError(request, 409, "Table changed; refresh and try again");
    const itemCount = await bindings.database.prepare("SELECT COUNT(*) AS count FROM pos_order_items WHERE order_id=?").bind(checkId).first<{ count: number }>();
    if (numberValue(itemCount?.count) > 0 || numberValue(target.check.total_cents) !== 0) return apiError(request, 409, "Only an empty zero-dollar check can use this V1 close action");
    await bindings.database.batch([
      bindings.database.prepare("UPDATE pos_orders SET status='CLOSED',progress='CHECK_PAID',closed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(checkId),
      bindings.database.prepare("UPDATE pos_tables SET status='CLOSED',progress='CHECK_PAID',closed_at=CURRENT_TIMESTAMP,active_number_key=NULL,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=?").bind(numberValue(target.table.id), revision),
      bindings.database.prepare("INSERT INTO pos_table_events(id,table_id,order_id,employee_id,event_type,details,created_at) VALUES(?,?,?,?,'EMPTY_CHECK_CLOSED',?,CURRENT_TIMESTAMP)")
        .bind(randomId(), numberValue(target.table.id), checkId, principal.employeeId, jsonText({ total_cents: 0 })),
    ]);
    return jsonResponse(request, await serializeTable(bindings.database, numberValue(target.table.id)));
  }
  return apiError(request, 404, "Not Found");
}

export async function routePOSTerminal(
  request: Request,
  url: URL,
  bindings: RuntimeBindings,
): Promise<Response | null> {
  if (!url.pathname.startsWith("/pos/")) return null;
  return await menuRoutes(request, url, bindings)
    ?? await orderRoutes(request, url, bindings)
    ?? await accessRoutes(request, url, bindings)
    ?? await pinRoutes(request, url, bindings)
    ?? await terminalRoutes(request, url, bindings);
}
