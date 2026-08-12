import { apiError, jsonResponse, methodNotAllowed } from "../http";
import type { RuntimeBindings } from "../runtime";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";
import { iso, isObject, jsonBody, jsonObject, jsonText, numberValue, randomId, type JsonObject } from "./pos-common";

type Row = Record<string, unknown>;

async function authorize(request: Request, bindings: RuntimeBindings, manager: boolean) {
  const auth = await authenticateRequest(request, bindings);
  if (auth.response !== null || auth.user === null || !manager) return auth;
  const denied = requireManagerOrAdmin(request, auth.user.role);
  return denied === null ? auth : { user: null, response: denied };
}

async function employeeForUser(database: D1Database, user: { employee_id: number | null; full_name: string }): Promise<Row | null> {
  if (user.employee_id !== null) return database.prepare("SELECT * FROM employees WHERE id=?").bind(user.employee_id).first<Row>();
  const name = user.full_name.trim().toLowerCase().replace(/\s+/gu, " "), parts = name.split(" ", 2);
  if (parts.length === 2) { const match = await database.prepare("SELECT * FROM employees WHERE lower(first_name)=? AND lower(last_name)=? LIMIT 1").bind(parts[0], parts[1]).first<Row>(); if (match !== null) return match; }
  return database.prepare("SELECT * FROM employees WHERE lower(nickname)=? LIMIT 1").bind(name).first<Row>();
}

function credit(row: Row): JsonObject { return { created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), id: numberValue(row.id), employee_id: numberValue(row.employee_id), balance: numberValue(row.balance) }; }

async function getOrCreateCredit(database: D1Database, employeeId: number): Promise<Row> {
  const current = await database.prepare("SELECT * FROM pyos_credits WHERE employee_id=?").bind(employeeId).first<Row>(); if (current !== null) return current;
  const id = randomId(); await database.prepare("INSERT INTO pyos_credits(id,employee_id,balance,created_at,updated_at) VALUES(?,?,0,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, employeeId).run();
  return database.prepare("SELECT * FROM pyos_credits WHERE id=?").bind(id).first<Row>() as Promise<Row>;
}

async function audit(database: D1Database, actorId: number, employeeId: number | null, action: string, delta: number | null, details: JsonObject): Promise<void> {
  await database.prepare("INSERT INTO pyos_audit(id,actor_user_id,employee_id,action,delta,details_json,created_at,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(randomId(), actorId, employeeId, action, delta, jsonText(details)).run();
}

function requestObject(row: Row): JsonObject {
  return { id: numberValue(row.id), employee_id: numberValue(row.employee_id), section_id: numberValue(row.section_id), date: String(row.date), shift: String(row.shift), status: String(row.status), notes: row.notes ?? null,
    created_by_user_id: numberValue(row.created_by_user_id), approved_by_user_id: row.approved_by_user_id === null ? null : numberValue(row.approved_by_user_id), denied_by_user_id: row.denied_by_user_id === null ? null : numberValue(row.denied_by_user_id),
    revoked_by_user_id: row.revoked_by_user_id === null ? null : numberValue(row.revoked_by_user_id), approved_at: row.approved_at === null ? null : iso(String(row.approved_at)), denied_at: row.denied_at === null ? null : iso(String(row.denied_at)), revoked_at: row.revoked_at === null ? null : iso(String(row.revoked_at)),
    created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), employee_name: row.first_name === undefined ? null : (`${String(row.first_name ?? "")} ${String(row.last_name ?? "")}`.trim() || row.nickname || null), section_label: row.section_label ?? null };
}

async function joinedRequest(database: D1Database, id: number): Promise<Row | null> {
  return database.prepare("SELECT r.*,e.first_name,e.last_name,e.nickname,s.label section_label FROM pyos_requests r LEFT JOIN employees e ON e.id=r.employee_id LEFT JOIN sections s ON s.id=r.section_id WHERE r.id=?").bind(id).first<Row>();
}

async function sectionAvailable(database: D1Database, sectionId: number, date: string, shift: string): Promise<boolean> {
  return await database.prepare("SELECT id FROM pyos_requests WHERE section_id=? AND date=? AND shift=? AND status IN ('PENDING','APPROVED') LIMIT 1").bind(sectionId, date, shift).first() === null;
}

async function creditRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/pyos/credits")) return null;
  const manager = url.pathname !== "/pyos/credits/me", auth = await authorize(request, bindings, manager); if (auth.response !== null || auth.user === null) return auth.response;
  if (url.pathname === "/pyos/credits/me") {
    if (request.method !== "GET") return methodNotAllowed(request, "GET"); const employee = await employeeForUser(bindings.database, auth.user); if (employee === null) return apiError(request, 404, "Employee profile not found for this user.");
    return jsonResponse(request, credit(await getOrCreateCredit(bindings.database, numberValue(employee.id))));
  }
  if (url.pathname === "/pyos/credits") {
    if (request.method !== "GET") return methodNotAllowed(request, "GET"); const employee = url.searchParams.get("employee_id"), result = employee === null ? await bindings.database.prepare("SELECT * FROM pyos_credits ORDER BY employee_id").all<Row>() : await bindings.database.prepare("SELECT * FROM pyos_credits WHERE employee_id=? ORDER BY employee_id").bind(Number(employee)).all<Row>();
    return jsonResponse(request, result.results.map(credit));
  }
  if (url.pathname !== "/pyos/credits/grant") return null; if (request.method !== "POST") return methodNotAllowed(request, "POST");
  const body = await jsonBody(request); if (body instanceof Response) return body; const employeeId = Number(body.employee_id), delta = Number(body.delta);
  if (await bindings.database.prepare("SELECT id FROM employees WHERE id=?").bind(employeeId).first() === null) return apiError(request, 404, "Employee not found"); if (!Number.isInteger(delta) || delta <= 0) return apiError(request, 422, "Credit delta must be greater than zero");
  await getOrCreateCredit(bindings.database, employeeId); await bindings.database.prepare("UPDATE pyos_credits SET balance=balance+?,updated_at=CURRENT_TIMESTAMP WHERE employee_id=?").bind(delta, employeeId).run(); const result = await bindings.database.prepare("SELECT * FROM pyos_credits WHERE employee_id=?").bind(employeeId).first<Row>() as Row;
  await audit(bindings.database, auth.user.id, employeeId, "grant", delta, { note: body.note ?? "", balance: numberValue(result.balance) }); return jsonResponse(request, credit(result));
}

async function createPyosRequest(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  const manual = url.pathname === "/pyos/requests/manual"; if (!manual && url.pathname !== "/pyos/requests") return null; if (request.method !== "POST") return null;
  const auth = await authorize(request, bindings, manual); if (auth.response !== null || auth.user === null) return auth.response; const body = await jsonBody(request); if (body instanceof Response) return body;
  let employee: Row | null;
  if (manual) employee = await bindings.database.prepare("SELECT * FROM employees WHERE id=?").bind(Number(body.employee_id)).first<Row>();
  else { if (auth.user.role !== "SERVER") return apiError(request, 403, "Only servers can submit PYOS requests."); employee = await employeeForUser(bindings.database, auth.user); }
  if (employee === null) return apiError(request, 404, manual ? "Employee not found" : "Employee profile not found for this user.");
  const employeeId = numberValue(employee.id), sectionId = Number(body.section_id), date = String(body.date), shift = String(body.shift);
  if (!manual && date < new Date().toISOString().slice(0, 10)) return apiError(request, 400, "Cannot request past dates.");
  if (!await sectionAvailable(bindings.database, sectionId, date, shift)) return apiError(request, 400, "Section already assigned for this shift.");
  if (!manual) { const existingCredit = await getOrCreateCredit(bindings.database, employeeId); if (numberValue(existingCredit.balance) < 1) return apiError(request, 400, "No PYOS credits available."); }
  const id = randomId(), status = manual ? "APPROVED" : "PENDING", approvedId = manual ? auth.user.id : null;
  const statements: D1PreparedStatement[] = [bindings.database.prepare("INSERT INTO pyos_requests(id,employee_id,section_id,date,shift,status,notes,created_by_user_id,approved_by_user_id,denied_by_user_id,revoked_by_user_id,approved_at,denied_at,revoked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,NULL,NULL,CASE WHEN ? IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END,NULL,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, employeeId, sectionId, date, shift, status, body.notes ?? null, auth.user.id, approvedId, approvedId)];
  if (!manual) statements.push(bindings.database.prepare("UPDATE pyos_credits SET balance=balance-1,updated_at=CURRENT_TIMESTAMP WHERE employee_id=? AND balance>0").bind(employeeId)); await bindings.database.batch(statements);
  await audit(bindings.database, auth.user.id, employeeId, manual ? "manual_assign" : "use", manual ? null : -1, { request_id: id, date, shift });
  return jsonResponse(request, requestObject(await joinedRequest(bindings.database, id) as Row), { status: 201 });
}

async function requestRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  const created = await createPyosRequest(request, url, bindings); if (created !== null) return created;
  if (url.pathname === "/pyos/requests") {
    if (request.method !== "GET") return methodNotAllowed(request, "GET, POST"); const auth = await authorize(request, bindings, false); if (auth.response !== null || auth.user === null) return auth.response;
    const conditions: string[] = [], values: Array<string | number> = [];
    if (auth.user.role === "SERVER") { const employee = await employeeForUser(bindings.database, auth.user); if (employee === null) return apiError(request, 404, "Employee profile not found for this user."); conditions.push("r.employee_id=?"); values.push(numberValue(employee.id)); }
    for (const field of ["date", "shift", "status"] as const) { const value = url.searchParams.get(field); if (value !== null) { conditions.push(`r.${field}=?`); values.push(value); } }
    const rows = await bindings.database.prepare(`SELECT r.*,e.first_name,e.last_name,e.nickname,s.label section_label FROM pyos_requests r LEFT JOIN employees e ON e.id=r.employee_id LEFT JOIN sections s ON s.id=r.section_id ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY r.date DESC,r.created_at DESC`).bind(...values).all<Row>(); return jsonResponse(request, rows.results.map(requestObject));
  }
  const match = /^\/pyos\/requests\/(\d+)\/(approve|deny|revoke)$/u.exec(url.pathname); if (match === null) return null; if (request.method !== "POST") return methodNotAllowed(request, "POST");
  const auth = await authorize(request, bindings, true); if (auth.response !== null || auth.user === null) return auth.response; const id = Number(match[1]), action = match[2], row = await joinedRequest(bindings.database, id); if (row === null) return apiError(request, 404, "Request not found");
  const expected = action === "revoke" ? "APPROVED" : "PENDING", pastTense = action === "approve" ? "approved" : action === "deny" ? "denied" : "revoked"; if (String(row.status) !== expected) return apiError(request, 400, `Only ${expected.toLowerCase()} requests can be ${pastTense}`);
  const body = await jsonBody(request); if (body instanceof Response) return body; const status = action === "approve" ? "APPROVED" : action === "deny" ? "DENIED" : "REVOKED", userColumn = action === "approve" ? "approved_by_user_id" : action === "deny" ? "denied_by_user_id" : "revoked_by_user_id", timeColumn = action === "approve" ? "approved_at" : action === "deny" ? "denied_at" : "revoked_at";
  const statements: D1PreparedStatement[] = [bindings.database.prepare(`UPDATE pyos_requests SET status=?,${userColumn}=?,${timeColumn}=CURRENT_TIMESTAMP,notes=CASE WHEN ? IS NULL OR ?='' THEN notes ELSE ? END,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(status, auth.user.id, body.notes ?? null, body.notes ?? null, body.notes ?? null, id)];
  if (action !== "approve") { await getOrCreateCredit(bindings.database, numberValue(row.employee_id)); statements.push(bindings.database.prepare("UPDATE pyos_credits SET balance=balance+1,updated_at=CURRENT_TIMESTAMP WHERE employee_id=?").bind(numberValue(row.employee_id))); }
  await bindings.database.batch(statements); await audit(bindings.database, auth.user.id, numberValue(row.employee_id), action, action === "approve" ? null : 1, { request_id: id, reason: body.notes ?? "" }); return jsonResponse(request, requestObject(await joinedRequest(bindings.database, id) as Row));
}

async function utilityRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (url.pathname === "/pyos/occupied") { const auth = await authorize(request, bindings, false); if (auth.response !== null) return auth.response; if (request.method !== "GET") return methodNotAllowed(request, "GET"); const date = url.searchParams.get("date"), shift = url.searchParams.get("shift"); if (date === null || shift === null) return apiError(request, 422, "date and shift are required"); const rows = await bindings.database.prepare("SELECT section_id FROM pyos_requests WHERE date=? AND shift=? AND status IN ('PENDING','APPROVED')").bind(date, shift).all<{ section_id: number }>(); return jsonResponse(request, rows.results.map((row) => row.section_id)); }
  if (url.pathname === "/pyos/audit") { const auth = await authorize(request, bindings, true); if (auth.response !== null) return auth.response; if (request.method !== "GET") return methodNotAllowed(request, "GET"); const employee = url.searchParams.get("employee_id"), rows = employee === null ? await bindings.database.prepare("SELECT * FROM pyos_audit ORDER BY created_at DESC LIMIT 200").all<Row>() : await bindings.database.prepare("SELECT * FROM pyos_audit WHERE employee_id=? ORDER BY created_at DESC LIMIT 200").bind(Number(employee)).all<Row>(); return jsonResponse(request, rows.results.map((row) => ({ created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), id: numberValue(row.id), actor_user_id: numberValue(row.actor_user_id), employee_id: row.employee_id === null ? null : numberValue(row.employee_id), action: String(row.action), delta: row.delta === null ? null : numberValue(row.delta), details_json: row.details_json === null ? null : jsonObject(row.details_json) }))); }
  return null;
}

export async function routePyos(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/pyos/")) return null;
  return await creditRoutes(request, url, bindings) ?? await requestRoutes(request, url, bindings) ?? await utilityRoutes(request, url, bindings);
}
