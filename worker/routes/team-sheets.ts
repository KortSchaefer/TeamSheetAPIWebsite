import { apiError, jsonResponse, methodNotAllowed } from "../http";
import type { RuntimeBindings } from "../runtime";
import { iso, isObject, jsonBody, nullableString, numberValue, randomId, requiredString, type JsonObject } from "./pos-common";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";

type Row = Record<string, unknown>;

interface AssignmentInput {
  employeeId: number;
  sectionId: number;
  roleLabel: string | null;
  orderIndex: number | null;
}

interface TaskInput {
  label: string;
  description: string | null;
  employeeIds: number[];
}

async function authorize(request: Request, bindings: RuntimeBindings, manager: boolean) {
  const auth = await authenticateRequest(request, bindings);
  if (auth.response !== null || auth.user === null || !manager) return auth;
  const denied = requireManagerOrAdmin(request, auth.user.role);
  return denied === null ? auth : { user: null, response: denied };
}

function assignmentInput(value: unknown): AssignmentInput | null {
  if (!isObject(value) || !Number.isInteger(Number(value.employee_id)) || !Number.isInteger(Number(value.section_id))) return null;
  return {
    employeeId: Number(value.employee_id), sectionId: Number(value.section_id),
    roleLabel: nullableString(value.role_label), orderIndex: value.order_index === null || value.order_index === undefined ? null : Number(value.order_index),
  };
}

function taskInput(value: unknown): TaskInput | null {
  if (!isObject(value) || typeof value.label !== "string" || value.label.trim().length === 0 || !Array.isArray(value.employee_ids)) return null;
  const employeeIds = value.employee_ids.map(Number);
  if (employeeIds.some((id) => !Number.isInteger(id))) return null;
  return { label: value.label.trim(), description: nullableString(value.description), employeeIds };
}

function parseList<T>(value: unknown, parser: (item: unknown) => T | null): T[] | null {
  if (!Array.isArray(value)) return null;
  const items = value.map(parser);
  return items.some((item) => item === null) ? null : items as T[];
}

function childrenAreValid(body: JsonObject, creating: boolean): boolean {
  if ((creating || "assignments" in body) && parseList(body.assignments ?? [], assignmentInput) === null) return false;
  for (const kind of ["sidework", "outwork"] as const) {
    if ((creating || kind in body) && parseList(body[kind] ?? [], taskInput) === null) return false;
  }
  return true;
}

async function serializeTeamSheet(database: D1Database, row: Row): Promise<JsonObject> {
  const id = numberValue(row.id);
  const [assignments, sidework, outwork] = await Promise.all([
    database.prepare(
      `SELECT a.*,e.first_name,e.last_name,s.label AS section_label FROM team_sheet_assignments a
       LEFT JOIN employees e ON e.id=a.employee_id LEFT JOIN sections s ON s.id=a.section_id
       WHERE a.team_sheet_id=? ORDER BY coalesce(a.order_index,2147483647),a.id`,
    ).bind(id).all<Row>(),
    database.prepare(
      `SELECT t.*,a.employee_id FROM sidework_tasks t LEFT JOIN sidework_assignments a ON a.task_id=t.id
       WHERE t.team_sheet_id=? ORDER BY t.id,a.id`,
    ).bind(id).all<Row>(),
    database.prepare(
      `SELECT t.*,a.employee_id FROM outwork_tasks t LEFT JOIN outwork_assignments a ON a.task_id=t.id
       WHERE t.team_sheet_id=? ORDER BY t.id,a.id`,
    ).bind(id).all<Row>(),
  ]);
  const groupTasks = (rows: Row[]) => {
    const groups = new Map<number, JsonObject>();
    for (const item of rows) {
      const taskId = numberValue(item.id);
      const task = groups.get(taskId) ?? { id: taskId, label: String(item.label), description: item.description ?? null, employee_ids: [] as number[] };
      if (item.employee_id !== null && item.employee_id !== undefined) (task.employee_ids as number[]).push(numberValue(item.employee_id));
      groups.set(taskId, task);
    }
    return [...groups.values()];
  };
  return {
    shift_id: numberValue(row.shift_id), title: String(row.title), status: String(row.status), notes: row.notes ?? null,
    created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), id, created_by_user_id: numberValue(row.created_by_user_id),
    assignments: assignments.results.map((item) => ({
      employee_id: numberValue(item.employee_id), section_id: numberValue(item.section_id), role_label: item.role_label ?? null,
      order_index: item.order_index === null ? null : numberValue(item.order_index), id: numberValue(item.id),
      employee_name: item.first_name === null ? null : `${String(item.first_name)} ${String(item.last_name)}`.trim(), section_label: item.section_label ?? null,
    })),
    sidework: groupTasks(sidework.results), outwork: groupTasks(outwork.results),
  };
}

async function fetchTeamSheet(database: D1Database, id: number): Promise<Row | null> {
  return database.prepare("SELECT * FROM team_sheets WHERE id=?").bind(id).first<Row>();
}

function taskStatements(database: D1Database, teamSheetId: number, table: "sidework" | "outwork", tasks: TaskInput[]): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  for (const task of tasks) {
    const taskId = randomId();
    statements.push(database.prepare(`INSERT INTO ${table}_tasks(id,team_sheet_id,label,description) VALUES(?,?,?,?)`).bind(taskId, teamSheetId, task.label, task.description));
    for (const employeeId of task.employeeIds) statements.push(database.prepare(`INSERT INTO ${table}_assignments(id,task_id,employee_id) VALUES(?,?,?)`).bind(randomId(), taskId, employeeId));
  }
  return statements;
}

async function replaceChildren(database: D1Database, teamSheetId: number, body: JsonObject, creating: boolean): Promise<Response | null> {
  const statements: D1PreparedStatement[] = [];
  if (creating || "assignments" in body) {
    const inputs = parseList(body.assignments ?? [], assignmentInput);
    if (inputs === null) return null;
    statements.push(database.prepare("DELETE FROM team_sheet_assignments WHERE team_sheet_id=?").bind(teamSheetId));
    for (const item of inputs) statements.push(database.prepare("INSERT INTO team_sheet_assignments(id,team_sheet_id,employee_id,section_id,role_label,order_index) VALUES(?,?,?,?,?,?)").bind(randomId(), teamSheetId, item.employeeId, item.sectionId, item.roleLabel, item.orderIndex));
  }
  for (const kind of ["sidework", "outwork"] as const) {
    if (!creating && !(kind in body)) continue;
    const inputs = parseList(body[kind] ?? [], taskInput);
    if (inputs === null) return null;
    statements.push(database.prepare(`DELETE FROM ${kind}_assignments WHERE task_id IN (SELECT id FROM ${kind}_tasks WHERE team_sheet_id=?)`).bind(teamSheetId));
    statements.push(database.prepare(`DELETE FROM ${kind}_tasks WHERE team_sheet_id=?`).bind(teamSheetId));
    statements.push(...taskStatements(database, teamSheetId, kind, inputs));
  }
  if (statements.length > 0) await database.batch(statements);
  return new Response(null, { status: 204 });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;").replace(/"/gu, "&quot;").replace(/'/gu, "&#39;");
}

function formatTime(value: string): string {
  const match = /^(\d{1,2}):(\d{2})/u.exec(value); if (match === null) return value;
  const hour = Number(match[1]), suffix = hour < 12 ? "AM" : "PM"; return `${hour % 12 || 12}:${match[2]} ${suffix}`;
}

async function exportResponse(request: Request, url: URL, database: D1Database, row: Row, data: JsonObject): Promise<Response> {
  if (url.pathname.endsWith("/export/json")) return jsonResponse(request, data);
  const id = numberValue(row.id), assignments = data.assignments as JsonObject[], sidework = data.sidework as JsonObject[], outwork = data.outwork as JsonObject[];
  const labels = (tasks: JsonObject[], employeeId: number) => tasks.filter((task) => (task.employee_ids as number[]).includes(employeeId)).map((task) => String(task.label)).join("; ");
  if (url.pathname.endsWith("/export/csv")) {
    const lines = [["Section", "Employee", "Role", "Sidework", "Outwork", "Notes"], ...assignments.map((item) => [item.section_label ?? "Unassigned", item.employee_name ?? "Unassigned", item.role_label ?? "", labels(sidework, numberValue(item.employee_id)), labels(outwork, numberValue(item.employee_id)), data.notes ?? ""])];
    return new Response(lines.map((line) => line.map(csvCell).join(",")).join("\r\n"), { headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename=team_sheet_${id}.csv`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  }
  const shift = await database.prepare("SELECT * FROM shifts WHERE id=?").bind(numberValue(row.shift_id)).first<Row>();
  let inTime = "";
  if (shift?.store_id !== null && shift?.store_id !== undefined) {
    const preference = await database.prepare("SELECT daily_schedule FROM store_preferences WHERE store_number=?").bind(String(shift.store_id)).first<{ daily_schedule: string }>();
    if (preference !== null) {
      try {
        const schedule = JSON.parse(preference.daily_schedule) as unknown;
        if (Array.isArray(schedule)) {
          const day = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" }).format(new Date(`${String(shift.date)}T00:00:00Z`));
          const entry = schedule.find((item) => isObject(item) && String(item.day ?? "").toLowerCase() === day.toLowerCase());
          if (isObject(entry)) inTime = String((String(shift.time_period) === "DINNER" ? entry.second_shift_in : entry.first_shift_in) ?? entry.open_time ?? "");
        }
      } catch { /* malformed legacy preference data is ignored, matching the optional behavior */ }
    }
  }
  const rows = assignments.map((item) => `<tr><td>${escapeHtml(formatTime(inTime))}</td><td>${escapeHtml(item.section_label ?? item.role_label)}</td><td>${escapeHtml(item.employee_name)}</td><td>${escapeHtml(labels(sidework, numberValue(item.employee_id)))}</td><td>${escapeHtml(labels(outwork, numberValue(item.employee_id)))}</td></tr>`).join("");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(data.title)}</title><style>body{font-family:"Segoe UI",Arial,sans-serif;margin:24px;color:#111}h1{margin:0 0 6px}.meta{color:#444;margin-bottom:16px}table{width:100%;border-collapse:collapse;font-size:14px}th,td{border:1px solid #444;padding:6px 8px;text-align:left;vertical-align:top}th{background:#efefef;text-transform:uppercase;font-size:12px;letter-spacing:.04em}</style></head><body><h1>${escapeHtml(data.title)}</h1><div class="meta">Status: ${escapeHtml(data.status)} ${escapeHtml(shift?.date)} ${escapeHtml(shift?.time_period)} ${shift?.store_id ? `Store ${escapeHtml(shift.store_id)}` : ""}</div><div class="meta">Notes: ${escapeHtml(data.notes)}</div><table><tr><th>In Time</th><th>Section</th><th>Employee</th><th>Sidework</th><th>Outwork</th></tr>${rows}</table></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}

export async function routeTeamSheets(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (url.pathname !== "/team-sheets" && !url.pathname.startsWith("/team-sheets/")) return null;
  const manager = request.method === "POST" || request.method === "PUT";
  const auth = await authorize(request, bindings, manager); if (auth.response !== null || auth.user === null) return auth.response;
  if (url.pathname === "/team-sheets") {
    if (request.method === "GET") {
      const conditions: string[] = [], values: Array<string | number> = [];
      for (const [parameter, column, operator] of [["start_date", "s.date", ">="], ["end_date", "s.date", "<="], ["status", "t.status", "="], ["time_period", "s.time_period", "="], ["manager_id", "t.created_by_user_id", "="]] as const) {
        const value = url.searchParams.get(parameter); if (value !== null) { conditions.push(`${column}${operator}?`); values.push(parameter === "manager_id" ? Number(value) : value); }
      }
      const result = await bindings.database.prepare(`SELECT t.* FROM team_sheets t JOIN shifts s ON s.id=t.shift_id ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY s.date DESC`).bind(...values).all<Row>();
      return jsonResponse(request, await Promise.all(result.results.map((row) => serializeTeamSheet(bindings.database, row))));
    }
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request); if (body instanceof Response) return body;
    const title = requiredString(request, body, "title", 255); if (title instanceof Response) return title;
    if (!childrenAreValid(body, true)) return apiError(request, 422, "Invalid team sheet assignments or tasks");
    const shiftId = Number(body.shift_id); if (!Number.isInteger(shiftId) || await bindings.database.prepare("SELECT id FROM shifts WHERE id=?").bind(shiftId).first() === null) return apiError(request, 404, "Shift not found");
    const id = randomId();
    if (body.source_team_sheet_id !== null && body.source_team_sheet_id !== undefined) {
      const sourceId = Number(body.source_team_sheet_id), source = await fetchTeamSheet(bindings.database, sourceId); if (source === null) return apiError(request, 404, "Source team sheet not found");
      await bindings.database.prepare("INSERT INTO team_sheets(id,shift_id,title,status,notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, shiftId, `${String(source.title)} (copy)`, String(body.status ?? "DRAFT"), source.notes ?? null, auth.user.id).run();
      const sourceData = await serializeTeamSheet(bindings.database, source);
      await replaceChildren(bindings.database, id, { assignments: sourceData.assignments, sidework: sourceData.sidework, outwork: sourceData.outwork }, true);
    } else {
      await bindings.database.prepare("INSERT INTO team_sheets(id,shift_id,title,status,notes,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, shiftId, title, String(body.status ?? "DRAFT"), body.notes ?? null, auth.user.id).run();
      const replaced = await replaceChildren(bindings.database, id, body, true); if (replaced === null) return apiError(request, 422, "Invalid team sheet assignments or tasks");
    }
    return jsonResponse(request, await serializeTeamSheet(bindings.database, await fetchTeamSheet(bindings.database, id) as Row), { status: 201 });
  }
  const match = /^\/team-sheets\/(\d+)(?:\/(export\/json|export\/csv|print))?$/u.exec(url.pathname); if (match === null) return apiError(request, 404, "Not Found");
  const id = Number(match[1]), row = await fetchTeamSheet(bindings.database, id); if (row === null) return apiError(request, 404, "Team sheet not found");
  if (match[2] !== undefined) {
    if (request.method !== "GET") return methodNotAllowed(request, "GET");
    return exportResponse(request, url, bindings.database, row, await serializeTeamSheet(bindings.database, row));
  }
  if (request.method === "GET") return jsonResponse(request, await serializeTeamSheet(bindings.database, row));
  if (request.method !== "PUT") return methodNotAllowed(request, "GET, PUT");
  const body = await jsonBody(request); if (body instanceof Response) return body;
  if (!childrenAreValid(body, false)) return apiError(request, 422, "Invalid team sheet assignments or tasks");
  const fields = ["title", "status", "notes"].filter((field) => field in body);
  if (fields.length > 0) await bindings.database.prepare(`UPDATE team_sheets SET ${fields.map((field) => `${field}=?`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...fields.map((field) => body[field] as string | null), id).run();
  const replaced = await replaceChildren(bindings.database, id, body, false); if (replaced === null) return apiError(request, 422, "Invalid team sheet assignments or tasks");
  return jsonResponse(request, await serializeTeamSheet(bindings.database, await fetchTeamSheet(bindings.database, id) as Row));
}
