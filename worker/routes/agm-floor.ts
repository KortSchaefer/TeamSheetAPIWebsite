import { apiError, jsonResponse, methodNotAllowed } from "../http";
import type { RuntimeBindings } from "../runtime";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";
import type { AGMCoordinationResult } from "../durable-objects/agm-service";

type JsonObject = Record<string, unknown>;
interface AGMRoomStub {
  syncRevision(revision: number): Promise<number>;
  begin(commandId: string, expectedRevision: number): Promise<AGMCoordinationResult>;
  complete(commandId: string, revision: number, result: unknown): Promise<void>;
  abort(commandId: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
}
type AGMBindings = RuntimeBindings & { serviceRooms: DurableObjectNamespace };

function object(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as JsonObject
    : null;
}

function jsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || value.length === 0) return [];
  try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function serializeLayout(row: JsonObject, tables?: JsonObject[]): JsonObject {
  const result: JsonObject = {
    ...row,
    areas: jsonArray(row.areas),
    fixtures: jsonArray(row.fixtures),
  };
  if (tables !== undefined) {
    result.tables = tables.map(table => ({ ...table, combinable_with: jsonArray(table.combinable_with) }));
  }
  return result;
}

function serializeParty(row: JsonObject): JsonObject {
  return { ...row, sms_consent: Boolean(row.sms_consent), table_numbers: jsonArray(row.table_numbers) };
}

async function bodyObject(request: Request): Promise<JsonObject | Response> {
  try {
    const value = object(await request.json());
    return value ?? apiError(request, 422, "JSON object required");
  } catch {
    return apiError(request, 422, "Invalid JSON body");
  }
}

async function authorize(request: Request, bindings: RuntimeBindings) {
  const auth = await authenticateRequest(request, bindings);
  if (auth.response !== null || auth.user === null) return { user: null, response: auth.response };
  return { user: auth.user, response: requireManagerOrAdmin(request, auth.user.role) };
}

async function ensureDefaultStore(database: D1Database, user: { id: number; role: string }): Promise<void> {
  await database.prepare(`
    INSERT INTO agm_stores (store_number, name, timezone, active, created_at, updated_at)
    SELECT '1', 'Restaurant 1', 'America/Chicago', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    WHERE NOT EXISTS (SELECT 1 FROM agm_stores WHERE store_number = '1')
  `).run();
  await database.prepare(`
    INSERT OR IGNORE INTO agm_store_memberships
      (store_id, user_id, access_role, active, created_at, updated_at)
    SELECT id, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM agm_stores WHERE store_number = '1'
  `).bind(user.id, user.role === "ADMIN" ? "ADMIN" : "AGM").run();
}

async function storeAllowed(database: D1Database, user: { id: number; role: string }, storeId: number): Promise<boolean> {
  if (user.role === "ADMIN") {
    return (await database.prepare("SELECT id FROM agm_stores WHERE id = ? AND active = 1").bind(storeId).first()) !== null;
  }
  return (await database.prepare(`
    SELECT s.id FROM agm_stores s
    JOIN agm_store_memberships m ON m.store_id = s.id
    WHERE s.id = ? AND s.active = 1 AND m.user_id = ? AND m.active = 1
  `).bind(storeId, user.id).first()) !== null;
}

async function layoutById(database: D1Database, layoutId: number): Promise<JsonObject | null> {
  const row = await database.prepare("SELECT * FROM agm_layouts WHERE id = ?").bind(layoutId).first<JsonObject>();
  if (row === null) return null;
  const tables = await database.prepare("SELECT * FROM agm_table_definitions WHERE layout_id = ? ORDER BY table_number").bind(layoutId).all<JsonObject>();
  return serializeLayout(row, tables.results);
}

async function bootstrapRoute(request: Request, user: { id: number; role: string }, bindings: AGMBindings): Promise<Response> {
  await ensureDefaultStore(bindings.database, user);
  const result = user.role === "ADMIN"
    ? await bindings.database.prepare("SELECT id, store_number, name, timezone FROM agm_stores WHERE active = 1 ORDER BY store_number").all()
    : await bindings.database.prepare(`
        SELECT s.id, s.store_number, s.name, s.timezone
        FROM agm_stores s JOIN agm_store_memberships m ON m.store_id = s.id
        WHERE m.user_id = ? AND m.active = 1 AND s.active = 1 ORDER BY s.store_number
      `).bind(user.id).all();
  return jsonResponse(request, {
    stores: result.results,
    permissions: { manage_memberships: user.role === "ADMIN", publish_layouts: true },
    sms_provider: { configured: false, name: null },
  });
}

async function layoutsRoute(request: Request, storeId: number, user: { id: number; role: string }, bindings: AGMBindings): Promise<Response> {
  if (!(await storeAllowed(bindings.database, user, storeId))) return apiError(request, 403, "You do not have access to this store");
  if (request.method === "GET") {
    const rows = await bindings.database.prepare("SELECT * FROM agm_layouts WHERE store_id = ? ORDER BY created_at DESC").bind(storeId).all<JsonObject>();
    return jsonResponse(request, rows.results.map(row => serializeLayout(row)));
  }
  if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
  const body = await bodyObject(request);
  if (body instanceof Response) return body;
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const tables = Array.isArray(body.tables) ? body.tables.map(object).filter((row): row is JsonObject => row !== null) : [];
  if (!name) return apiError(request, 422, "Layout name is required");
  const versionRow = await bindings.database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM agm_layouts WHERE store_id = ? AND name = ?").bind(storeId, name).first<{ version: number }>();
  const inserted = await bindings.database.prepare(`
    INSERT INTO agm_layouts
      (store_id, name, version, status, revision, canvas_width, canvas_height, areas, fixtures, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, 'DRAFT', 1, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    RETURNING id
  `).bind(
    storeId, name, (versionRow?.version ?? 0) + 1,
    Number(body.canvas_width) || 1200, Number(body.canvas_height) || 760,
    JSON.stringify(body.areas ?? []), JSON.stringify(body.fixtures ?? []), user.id,
  ).first<{ id: number }>();
  if (inserted === null) return apiError(request, 500, "Layout creation failed");
  if (tables.length > 0) {
    await bindings.database.batch(tables.map(table => bindings.database.prepare(`
      INSERT INTO agm_table_definitions
        (layout_id, table_number, label, capacity, shape, x, y, width, height, rotation, area_name, section_name, combinable_with, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    `).bind(
      inserted.id, String(table.table_number), String(table.label ?? table.table_number), Number(table.capacity) || 2,
      String(table.shape ?? "ROUND"), Number(table.x) || 0, Number(table.y) || 0,
      Number(table.width) || 88, Number(table.height) || 88, Number(table.rotation) || 0,
      table.area_name ?? null, table.section_name ?? null, JSON.stringify(table.combinable_with ?? []),
    )));
  }
  return jsonResponse(request, await layoutById(bindings.database, inserted.id), { status: 201 });
}

async function layoutRoute(request: Request, layoutId: number, action: string | undefined, user: { id: number; role: string }, bindings: AGMBindings): Promise<Response> {
  const row = await bindings.database.prepare("SELECT * FROM agm_layouts WHERE id = ?").bind(layoutId).first<JsonObject>();
  if (row === null) return apiError(request, 404, "Layout not found");
  if (!(await storeAllowed(bindings.database, user, Number(row.store_id)))) return apiError(request, 403, "You do not have access to this store");
  if (action === "publish") {
    if (request.method !== "POST") return methodNotAllowed(request, "POST");
    const count = await bindings.database.prepare("SELECT COUNT(*) AS count FROM agm_table_definitions WHERE layout_id = ?").bind(layoutId).first<{ count: number }>();
    if ((count?.count ?? 0) === 0) return apiError(request, 422, "Add at least one table before publishing");
    await bindings.database.batch([
      bindings.database.prepare("UPDATE agm_layouts SET status = 'ARCHIVED', updated_at = CURRENT_TIMESTAMP WHERE store_id = ? AND status = 'PUBLISHED' AND id != ?").bind(row.store_id, layoutId),
      bindings.database.prepare("UPDATE agm_layouts SET status = 'PUBLISHED', published_at = CURRENT_TIMESTAMP, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(layoutId),
    ]);
    return jsonResponse(request, await layoutById(bindings.database, layoutId));
  }
  if (request.method === "GET") return jsonResponse(request, await layoutById(bindings.database, layoutId));
  if (request.method !== "PUT") return methodNotAllowed(request, "GET, PUT");
  if (row.status !== "DRAFT") return apiError(request, 409, "Published layouts are immutable; create a new draft");
  const body = await bodyObject(request);
  if (body instanceof Response) return body;
  if (Number(body.revision) !== Number(row.revision)) return apiError(request, 409, "Layout revision is stale");
  const tables = Array.isArray(body.tables) ? body.tables.map(object).filter((item): item is JsonObject => item !== null) : [];
  const statements: D1PreparedStatement[] = [
    bindings.database.prepare(`UPDATE agm_layouts SET name = ?, canvas_width = ?, canvas_height = ?, areas = ?, fixtures = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(
      String(body.name ?? row.name), Number(body.canvas_width) || 1200, Number(body.canvas_height) || 760,
      JSON.stringify(body.areas ?? []), JSON.stringify(body.fixtures ?? []), layoutId,
    ),
    bindings.database.prepare("DELETE FROM agm_table_definitions WHERE layout_id = ?").bind(layoutId),
  ];
  for (const table of tables) statements.push(bindings.database.prepare(`
    INSERT INTO agm_table_definitions
      (layout_id, table_number, label, capacity, shape, x, y, width, height, rotation, area_name, section_name, combinable_with, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
  `).bind(layoutId, String(table.table_number), String(table.label ?? table.table_number), Number(table.capacity) || 2, String(table.shape ?? "ROUND"), Number(table.x) || 0, Number(table.y) || 0, Number(table.width) || 88, Number(table.height) || 88, Number(table.rotation) || 0, table.area_name ?? null, table.section_name ?? null, JSON.stringify(table.combinable_with ?? [])));
  await bindings.database.batch(statements);
  return jsonResponse(request, await layoutById(bindings.database, layoutId));
}

async function servicesRoute(request: Request, storeId: number, user: { id: number; role: string }, bindings: AGMBindings): Promise<Response> {
  if (!(await storeAllowed(bindings.database, user, storeId))) return apiError(request, 403, "You do not have access to this store");
  if (request.method === "GET") {
    const rows = await bindings.database.prepare("SELECT * FROM agm_services WHERE store_id = ? ORDER BY service_date DESC, created_at DESC").bind(storeId).all();
    return jsonResponse(request, rows.results);
  }
  if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
  const body = await bodyObject(request);
  if (body instanceof Response) return body;
  const layoutId = Number(body.layout_id);
  const layout = await bindings.database.prepare("SELECT id FROM agm_layouts WHERE id = ? AND store_id = ? AND status = 'PUBLISHED'").bind(layoutId, storeId).first();
  if (layout === null) return apiError(request, 422, "Choose a published layout for this store");
  const existing = await bindings.database.prepare("SELECT * FROM agm_services WHERE store_id = ? AND service_date = ? AND name = ?").bind(storeId, body.service_date, body.name ?? "Dinner").first();
  if (existing !== null) return jsonResponse(request, existing);
  const inserted = await bindings.database.prepare(`
    INSERT INTO agm_services
      (store_id, layout_id, service_date, name, status, starts_at, ends_at, revision, opened_by_user_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'OPEN', ?, ?, 0, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *
  `).bind(storeId, layoutId, body.service_date, body.name ?? "Dinner", body.starts_at ?? null, body.ends_at ?? null, user.id).first<JsonObject>();
  if (inserted === null) return apiError(request, 500, "Service creation failed");
  await bindings.database.prepare(`
    INSERT INTO agm_table_states (service_id, table_number, status, revision, created_at, updated_at)
    SELECT ?, table_number, 'AVAILABLE', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    FROM agm_table_definitions WHERE layout_id = ?
  `).bind(inserted.id, layoutId).run();
  return jsonResponse(request, inserted, { status: 201 });
}

async function serviceBootstrap(request: Request, serviceId: number, user: { id: number; role: string }, bindings: AGMBindings): Promise<Response> {
  const service = await bindings.database.prepare("SELECT * FROM agm_services WHERE id = ?").bind(serviceId).first<JsonObject>();
  if (service === null) return apiError(request, 404, "Service not found");
  if (!(await storeAllowed(bindings.database, user, Number(service.store_id)))) return apiError(request, 403, "You do not have access to this store");
  const [layout, states, parties, rotations] = await Promise.all([
    layoutById(bindings.database, Number(service.layout_id)),
    bindings.database.prepare("SELECT table_number, status, party_id, revision FROM agm_table_states WHERE service_id = ? ORDER BY table_number").bind(serviceId).all(),
    bindings.database.prepare("SELECT * FROM agm_parties WHERE service_id = ? ORDER BY reservation_at, created_at").bind(serviceId).all<JsonObject>(),
    bindings.database.prepare(`SELECT r.*, COALESCE(e.nickname, e.first_name || ' ' || e.last_name) AS employee_name FROM agm_server_rotations r JOIN employees e ON e.id = r.employee_id WHERE r.service_id = ? ORDER BY r.rotation_index`).bind(serviceId).all(),
  ]);
  const room = bindings.serviceRooms.getByName(`service:${serviceId}`) as unknown as AGMRoomStub;
  await room.syncRevision(Number(service.revision));
  return jsonResponse(request, {
    service,
    layout,
    table_states: states.results,
    parties: parties.results.map(row => serializeParty(row)),
    rotation: rotations.results,
    recommendations: recommendations(layout, states.results as JsonObject[], parties.results, rotations.results as JsonObject[]),
    sms_provider: { configured: false },
  });
}

function recommendations(layout: JsonObject | null, states: JsonObject[], parties: JsonObject[], rotations: JsonObject[]): JsonObject[] {
  const definitions = new Map((layout?.tables as JsonObject[] | undefined ?? []).map(row => [String(row.table_number), row]));
  const available = states.filter(row => row.status === "AVAILABLE");
  const servers = rotations.filter(row => !Boolean(row.paused)).sort((a, b) => Number(a.covers) - Number(b.covers) || Number(a.turns) - Number(b.turns));
  return parties.filter(row => ["WAITING", "ARRIVED", "NOTIFIED"].includes(String(row.status))).slice(0, 8).map(party => {
    const suitable = available.filter(row => Number(definitions.get(String(row.table_number))?.capacity ?? 0) >= Number(party.party_size)).sort((a, b) => Number(definitions.get(String(a.table_number))?.capacity) - Number(definitions.get(String(b.table_number))?.capacity));
    return { party_id: party.id, table_number: suitable[0]?.table_number ?? null, server_employee_id: servers[0]?.employee_id ?? null, reason: suitable.length ? "Best capacity fit with the lightest active server rotation" : "No single available table fits this party" };
  });
}

async function partiesRoute(request: Request, serviceId: number, user: { id: number; role: string }, bindings: AGMBindings): Promise<Response> {
  const service = await bindings.database.prepare("SELECT * FROM agm_services WHERE id = ?").bind(serviceId).first<JsonObject>();
  if (service === null) return apiError(request, 404, "Service not found");
  if (!(await storeAllowed(bindings.database, user, Number(service.store_id)))) return apiError(request, 403, "You do not have access to this store");
  if (request.method === "GET") {
    const rows = await bindings.database.prepare("SELECT * FROM agm_parties WHERE service_id = ? ORDER BY reservation_at, created_at").bind(serviceId).all<JsonObject>();
    return jsonResponse(request, rows.results.map(row => serializeParty(row)));
  }
  if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
  const body = await bodyObject(request);
  if (body instanceof Response) return body;
  if (!body.guest_name || Number(body.party_size) < 1) return apiError(request, 422, "Guest name and party size are required");
  const source = String(body.source ?? "WAITLIST");
  const row = await bindings.database.prepare(`
    INSERT INTO agm_parties
      (store_id, service_id, source, status, guest_name, phone, party_size, reservation_at, quoted_minutes, notes, sms_consent, revision, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) RETURNING *
  `).bind(service.store_id, serviceId, source, body.status ?? (source === "RESERVATION" ? "BOOKED" : "WAITING"), body.guest_name, body.phone ?? null, Number(body.party_size), body.reservation_at ?? null, body.quoted_minutes ?? null, body.notes ?? null, body.sms_consent ? 1 : 0).first<JsonObject>();
  return jsonResponse(request, row === null ? null : serializeParty(row), { status: 201 });
}

async function partyRoute(request: Request, partyId: number, user: { id: number; role: string }, bindings: AGMBindings): Promise<Response> {
  if (request.method !== "PATCH") return methodNotAllowed(request, "PATCH");
  const party = await bindings.database.prepare("SELECT * FROM agm_parties WHERE id = ?").bind(partyId).first<JsonObject>();
  if (party === null) return apiError(request, 404, "Party not found");
  if (!(await storeAllowed(bindings.database, user, Number(party.store_id)))) return apiError(request, 403, "You do not have access to this store");
  const body = await bodyObject(request);
  if (body instanceof Response) return body;
  if (Number(body.revision) !== Number(party.revision)) return apiError(request, 409, "Party revision is stale");
  const allowedStatuses = new Set(["BOOKED", "CONFIRMED", "WAITING", "NOTIFIED", "ARRIVED", "SEATED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
  if (body.status !== undefined && !allowedStatuses.has(String(body.status))) return apiError(request, 422, "Invalid party status");
  const has = (key: string) => Object.prototype.hasOwnProperty.call(body, key);
  const updated = await bindings.database.prepare(`
    UPDATE agm_parties SET
      status = ?, guest_name = ?, phone = ?, party_size = ?, reservation_at = ?, quoted_minutes = ?, notes = ?, sms_consent = ?,
      revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND revision = ? RETURNING *
  `).bind(
    has("status") ? body.status : party.status,
    has("guest_name") ? body.guest_name : party.guest_name,
    has("phone") ? body.phone : party.phone,
    has("party_size") ? body.party_size : party.party_size,
    has("reservation_at") ? body.reservation_at : party.reservation_at,
    has("quoted_minutes") ? body.quoted_minutes : party.quoted_minutes,
    has("notes") ? body.notes : party.notes,
    has("sms_consent") ? (body.sms_consent ? 1 : 0) : party.sms_consent,
    partyId, body.revision,
  ).first<JsonObject>();
  if (updated === null) return apiError(request, 409, "Party revision is stale");
  return jsonResponse(request, serializeParty(updated));
}

async function rotationRoute(request: Request, serviceId: number, user: { id: number; role: string }, bindings: AGMBindings): Promise<Response> {
  const service = await bindings.database.prepare("SELECT * FROM agm_services WHERE id = ?").bind(serviceId).first<JsonObject>();
  if (service === null) return apiError(request, 404, "Service not found");
  if (!(await storeAllowed(bindings.database, user, Number(service.store_id)))) return apiError(request, 403, "You do not have access to this store");
  const candidateQuery = `
    SELECT e.id AS employee_id, COALESCE(e.nickname, e.first_name || ' ' || e.last_name) AS employee_name,
      (SELECT sec.label FROM team_sheet_assignments a JOIN team_sheets ts ON ts.id = a.team_sheet_id JOIN shifts sh ON sh.id = ts.shift_id JOIN sections sec ON sec.id = a.section_id WHERE a.employee_id = e.id AND ts.status = 'PUBLISHED' AND sh.date = ? AND (sh.store_id = ? OR sh.store_id IS NULL) ORDER BY a.order_index LIMIT 1) AS section_name,
      EXISTS(SELECT 1 FROM team_sheet_assignments a JOIN team_sheets ts ON ts.id = a.team_sheet_id JOIN shifts sh ON sh.id = ts.shift_id WHERE a.employee_id = e.id AND ts.status = 'PUBLISHED' AND sh.date = ? AND (sh.store_id = ? OR sh.store_id IS NULL)) AS from_team_sheet,
      COALESCE((SELECT a.order_index FROM team_sheet_assignments a JOIN team_sheets ts ON ts.id = a.team_sheet_id JOIN shifts sh ON sh.id = ts.shift_id WHERE a.employee_id = e.id AND ts.status = 'PUBLISHED' AND sh.date = ? AND (sh.store_id = ? OR sh.store_id IS NULL) ORDER BY a.order_index LIMIT 1), 9999) AS order_index
    FROM employees e
    WHERE e.active = 1 AND e.role = 'SERVER'
    ORDER BY order_index, employee_name
  `;
  if (request.method === "GET") {
    const [current, candidates] = await Promise.all([
      bindings.database.prepare(`SELECT r.*, COALESCE(e.nickname, e.first_name || ' ' || e.last_name) AS employee_name FROM agm_server_rotations r JOIN employees e ON e.id = r.employee_id WHERE r.service_id = ? ORDER BY r.rotation_index`).bind(serviceId).all(),
      bindings.database.prepare(candidateQuery).bind(service.service_date, service.store_id, service.service_date, service.store_id, service.service_date, service.store_id).all(),
    ]);
    return jsonResponse(request, { current: current.results, candidates: candidates.results });
  }
  if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
  let payload: unknown;
  try { payload = await request.json(); } catch { return apiError(request, 422, "Invalid JSON body"); }
  const rows = Array.isArray(payload) ? payload.map(object).filter((row): row is JsonObject => row !== null) : [];
  const employeeIds = rows.map(row => Number(row.employee_id));
  if (employeeIds.some(id => !Number.isSafeInteger(id)) || new Set(employeeIds).size !== employeeIds.length) return apiError(request, 422, "Rotation employees must be unique and valid");
  if (employeeIds.length > 0) {
    const found = await bindings.database.prepare(`SELECT id FROM employees WHERE active = 1 AND id IN (${employeeIds.map(() => "?").join(",")})`).bind(...employeeIds).all();
    if (found.results.length !== employeeIds.length) return apiError(request, 422, "One or more rotation employees were not found");
  }
  const statements: D1PreparedStatement[] = [bindings.database.prepare("DELETE FROM agm_server_rotations WHERE service_id = ?").bind(serviceId)];
  rows.forEach((row, index) => statements.push(bindings.database.prepare(`INSERT INTO agm_server_rotations (service_id, employee_id, section_name, rotation_index, paused, turns, covers, created_at, updated_at) VALUES (?, ?, ?, ?, 0, 0, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).bind(serviceId, row.employee_id, row.section_name ?? null, index)));
  await bindings.database.batch(statements);
  return jsonResponse(request, { updated: rows.length });
}

async function commandRoute(request: Request, serviceId: number, user: { id: number; role: string }, bindings: AGMBindings): Promise<Response> {
  if (request.method !== "POST") return methodNotAllowed(request, "POST");
  const service = await bindings.database.prepare("SELECT * FROM agm_services WHERE id = ?").bind(serviceId).first<JsonObject>();
  if (service === null) return apiError(request, 404, "Service not found");
  if (!(await storeAllowed(bindings.database, user, Number(service.store_id)))) return apiError(request, 403, "You do not have access to this store");
  const body = await bodyObject(request);
  if (body instanceof Response) return body;
  const commandId = typeof body.command_id === "string" ? body.command_id : "";
  const expectedRevision = Number(body.expected_revision);
  if (commandId.length < 8 || !Number.isSafeInteger(expectedRevision)) return apiError(request, 422, "command_id and expected_revision are required");
  const room = bindings.serviceRooms.getByName(`service:${serviceId}`) as unknown as AGMRoomStub;
  await room.syncRevision(Number(service.revision));
  const gate = await room.begin(commandId, expectedRevision);
  if (gate.status === "COMPLETED") return jsonResponse(request, gate.result);
  if (gate.status === "CONFLICT") return apiError(request, 409, "Service revision is stale");
  if (gate.status === "BUSY") return apiError(request, 503, "Another floor command is being committed");
  try {
    const result = await applyD1Command(request, bindings.database, service, user.id, body);
    if (result instanceof Response) { await room.abort(commandId); return result; }
    await room.complete(commandId, Number(result.service_revision), result);
    return jsonResponse(request, result);
  } catch (error) {
    await room.abort(commandId);
    throw error;
  }
}

async function applyD1Command(request: Request, database: D1Database, service: JsonObject, userId: number, body: JsonObject): Promise<JsonObject | Response> {
  const serviceId = Number(service.id);
  const type = String(body.type ?? "");
  const partyId = Number(body.party_id) || null;
  const tableNumbers = Array.isArray(body.table_numbers) ? body.table_numbers.map(String) : [];
  const party = partyId === null ? null : await database.prepare("SELECT * FROM agm_parties WHERE id = ? AND service_id = ?").bind(partyId, serviceId).first<JsonObject>();
  const states = tableNumbers.length === 0 ? { results: [] as JsonObject[] } : await database.prepare(`SELECT * FROM agm_table_states WHERE service_id = ? AND table_number IN (${tableNumbers.map(() => "?").join(",")})`).bind(serviceId, ...tableNumbers).all<JsonObject>();
  const nextRevision = Number(service.revision) + 1;
  const statements: D1PreparedStatement[] = [];
  if (["SEAT", "MOVE", "COMBINE"].includes(type)) {
    if (party === null || states.results.length !== new Set(tableNumbers).size) return apiError(request, 422, "Choose a party and valid tables");
    if (states.results.some(row => row.status !== "AVAILABLE" && Number(row.party_id) !== partyId)) return apiError(request, 409, "One or more tables are unavailable");
    const defs = await database.prepare(`SELECT capacity FROM agm_table_definitions WHERE layout_id = ? AND table_number IN (${tableNumbers.map(() => "?").join(",")})`).bind(service.layout_id, ...tableNumbers).all<{ capacity: number }>();
    if (defs.results.reduce((sum, row) => sum + Number(row.capacity), 0) < Number(party.party_size)) return apiError(request, 422, "Selected tables do not fit the party");
    statements.push(database.prepare("UPDATE agm_table_states SET status = 'AVAILABLE', party_id = NULL, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE service_id = ? AND party_id = ?").bind(serviceId, partyId));
    for (const tableNumber of tableNumbers) statements.push(database.prepare("UPDATE agm_table_states SET status = 'SEATED', party_id = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE service_id = ? AND table_number = ?").bind(partyId, serviceId, tableNumber));
    statements.push(database.prepare("UPDATE agm_parties SET status = 'SEATED', table_numbers = ?, server_employee_id = ?, dining_stage = 'SEATED', seated_at = COALESCE(seated_at, CURRENT_TIMESTAMP), revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(JSON.stringify(tableNumbers), body.server_employee_id ?? null, partyId));
    if (type === "SEAT" && body.server_employee_id) statements.push(database.prepare("UPDATE agm_server_rotations SET turns = turns + 1, covers = covers + ?, last_sat_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE service_id = ? AND employee_id = ?").bind(party.party_size, serviceId, body.server_employee_id));
  } else if (type === "CLEAR") {
    if (party === null) return apiError(request, 422, "Choose a seated party");
    statements.push(database.prepare("UPDATE agm_table_states SET status = 'CLEANING', party_id = NULL, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE service_id = ? AND party_id = ?").bind(serviceId, partyId));
    statements.push(database.prepare("UPDATE agm_parties SET status = 'COMPLETED', cleared_at = CURRENT_TIMESTAMP, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(partyId));
  } else if (type === "SET_TABLE_STATUS") {
    if (!states.results.length || !["AVAILABLE", "HELD", "CLEANING", "BLOCKED"].includes(String(body.status))) return apiError(request, 422, "Choose tables and a valid status");
    if (states.results.some(row => row.party_id !== null)) return apiError(request, 409, "Move or clear the seated party first");
    for (const tableNumber of tableNumbers) statements.push(database.prepare("UPDATE agm_table_states SET status = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE service_id = ? AND table_number = ?").bind(body.status, serviceId, tableNumber));
  } else if (type === "ADVANCE_STAGE") {
    if (party === null || !["SEATED", "ORDERED", "ENTREES", "CHECK_DROPPED"].includes(String(body.dining_stage))) return apiError(request, 422, "Choose a seated party and dining stage");
    statements.push(database.prepare("UPDATE agm_parties SET dining_stage = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(body.dining_stage, partyId));
  } else if (type === "NOTIFY") {
    if (party === null || !party.phone || !Boolean(party.sms_consent)) return apiError(request, 422, "SMS consent and a phone number are required");
    statements.push(database.prepare("UPDATE agm_parties SET status = 'NOTIFIED', revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(partyId));
    statements.push(database.prepare(`INSERT INTO agm_sms_outbox (store_id, party_id, template_key, recipient_phone, body, status, created_at, updated_at) VALUES (?, ?, 'TABLE_READY', ?, ?, 'PROVIDER_UNCONFIGURED', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`).bind(service.store_id, partyId, party.phone, `${party.guest_name}, your table is ready. Please return to the host stand.`));
  } else if (type === "PAUSE_SERVER") {
    const employeeId = Number(body.server_employee_id);
    if (!Number.isSafeInteger(employeeId) || typeof body.paused !== "boolean") return apiError(request, 422, "Choose a server and pause state");
    const rotation = await database.prepare("SELECT employee_id FROM agm_server_rotations WHERE service_id = ? AND employee_id = ?").bind(serviceId, employeeId).first();
    if (rotation === null) return apiError(request, 422, "Choose a server in this rotation");
    statements.push(database.prepare("UPDATE agm_server_rotations SET paused = ?, updated_at = CURRENT_TIMESTAMP WHERE service_id = ? AND employee_id = ?").bind(body.paused ? 1 : 0, serviceId, employeeId));
  } else if (type === "CLOSE_SERVICE") {
    const occupied = await database.prepare("SELECT COUNT(*) AS count FROM agm_table_states WHERE service_id = ? AND party_id IS NOT NULL").bind(serviceId).first<{ count: number }>();
    if ((occupied?.count ?? 0) > 0) return apiError(request, 409, "Clear all seated parties before closing service");
    statements.push(database.prepare("UPDATE agm_services SET status = 'CLOSED', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(serviceId));
  } else return apiError(request, 422, "Unsupported command");
  statements.push(database.prepare("UPDATE agm_services SET revision = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(nextRevision, serviceId));
  statements.push(database.prepare("INSERT INTO agm_events (service_id, sequence, command_id, event_type, payload, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)").bind(serviceId, nextRevision, body.command_id, type, JSON.stringify(body), userId));
  await database.batch(statements);
  return { service_revision: nextRevision, event: { sequence: nextRevision, command_id: body.command_id, type, payload: body } };
}

export async function routeAGMFloor(request: Request, url: URL, bindings: AGMBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/agm/")) return null;
  const auth = await authorize(request, bindings);
  if (auth.response !== null || auth.user === null) return auth.response;
  const user = auth.user;
  if (url.pathname === "/agm/bootstrap") return request.method === "GET" ? bootstrapRoute(request, user, bindings) : methodNotAllowed(request, "GET");
  let match = /^\/agm\/parties\/(\d+)$/u.exec(url.pathname);
  if (match) return partyRoute(request, Number(match[1]), user, bindings);
  match = /^\/agm\/stores\/(\d+)\/(layouts|services)$/u.exec(url.pathname);
  if (match) return match[2] === "layouts" ? layoutsRoute(request, Number(match[1]), user, bindings) : servicesRoute(request, Number(match[1]), user, bindings);
  match = /^\/agm\/layouts\/(\d+)(?:\/(publish))?$/u.exec(url.pathname);
  if (match) return layoutRoute(request, Number(match[1]), match[2], user, bindings);
  match = /^\/agm\/services\/(\d+)\/(bootstrap|parties|commands|rotation|events)$/u.exec(url.pathname);
  if (match) {
    const serviceId = Number(match[1]);
    if (match[2] === "bootstrap") return request.method === "GET" ? serviceBootstrap(request, serviceId, user, bindings) : methodNotAllowed(request, "GET");
    if (match[2] === "parties") return partiesRoute(request, serviceId, user, bindings);
    if (match[2] === "commands") return commandRoute(request, serviceId, user, bindings);
    if (match[2] === "rotation") return rotationRoute(request, serviceId, user, bindings);
    if (request.method !== "GET") return methodNotAllowed(request, "GET");
    const service = await bindings.database.prepare("SELECT store_id FROM agm_services WHERE id = ?").bind(serviceId).first<{ store_id: number }>();
    if (service === null) return apiError(request, 404, "Service not found");
    if (!(await storeAllowed(bindings.database, user, service.store_id))) return apiError(request, 403, "You do not have access to this store");
    return (bindings.serviceRooms.getByName(`service:${serviceId}`) as unknown as AGMRoomStub).fetch(request);
  }
  return apiError(request, 404, "Not Found");
}

export type { AGMBindings };
