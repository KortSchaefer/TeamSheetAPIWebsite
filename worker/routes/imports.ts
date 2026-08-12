import { apiError, jsonResponse, methodNotAllowed } from "../http";
import type { RuntimeBindings } from "../runtime";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";
import { jsonText, numberValue, randomId } from "./pos-common";

function parseCsv(text: string): Array<Record<string, string>> {
  const records: string[][] = []; let row: string[] = [], field = "", quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted && character === '"' && text[index + 1] === '"') { field += '"'; index += 1; }
    else if (character === '"') quoted = !quoted;
    else if (!quoted && character === ",") { row.push(field); field = ""; }
    else if (!quoted && (character === "\n" || character === "\r")) { if (character === "\r" && text[index + 1] === "\n") index += 1; row.push(field); field = ""; if (row.some((item) => item.length > 0)) records.push(row); row = []; }
    else field += character;
  }
  if (field.length > 0 || row.length > 0) { row.push(field); records.push(row); }
  if (records.length === 0) return [];
  const headers = records[0].map((value) => value.replace(/^\uFEFF/u, "").trim());
  return records.slice(1).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function normalizeHeader(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/gu, "_").replace(/^_+|_+$/gu, "");
}

function first(row: Record<string, string>, names: string[]): string | null {
  const expected = new Set(names.map(normalizeHeader));
  for (const [key, value] of Object.entries(row)) if (expected.has(normalizeHeader(key)) && value.trim().length > 0) return value.trim();
  return null;
}

function optionalInt(value: string | null): number | null { if (value === null) return null; const parsed = Math.trunc(Number(value)); return Number.isFinite(parsed) ? parsed : null; }
function optionalBlast(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Number(value.trim().replace(/%$/u, "").trim());
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
}

async function uploadedCsv(request: Request): Promise<Array<Record<string, string>> | Response> {
  let form: FormData; try { form = await request.formData(); } catch { return apiError(request, 422, "A CSV file is required"); }
  const file = form.get("file"); if (file === null || typeof file === "string" || typeof (file as Blob).arrayBuffer !== "function") return apiError(request, 422, "A CSV file is required"); const bytes = await (file as Blob).arrayBuffer(); let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes); } catch { text = new TextDecoder("windows-1252").decode(bytes); }
  return parseCsv(text);
}

export async function routeImports(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/imports/")) return null; const auth = await authenticateRequest(request, bindings); if (auth.response !== null || auth.user === null) return auth.response;
  const denied = requireManagerOrAdmin(request, auth.user.role); if (denied !== null) return denied; if (request.method !== "POST") return methodNotAllowed(request, "POST");
  const rows = await uploadedCsv(request); if (rows instanceof Response) return rows; const headers = rows.length === 0 ? [] : Object.keys(rows[0]).map(normalizeHeader);
  if (url.pathname === "/imports/servers") {
    if (!headers.includes("name")) return apiError(request, 400, "CSV must include a 'name' column."); let created = 0, updated = 0;
    for (const row of rows) {
      const name = first(row, ["name"]); if (name === null) continue; const parts = name.split(/\s+/u), firstName = parts[0], lastName = parts[1] ?? "";
      const current = await bindings.database.prepare("SELECT id FROM employees WHERE first_name=? AND last_name=? LIMIT 1").bind(firstName, lastName).first<{ id: number }>(), id = current?.id ?? randomId();
      const nickname = first(row, ["nickname"]), upsell = optionalBlast(first(row, ["upsell_score", "upsell", "blast", "blast_percent", "blast_percentage", "blast_score"])), pitty = optionalInt(first(row, ["pitty", "pity"])), days = optionalInt(first(row, ["employment_days", "employment"])), capacity = optionalInt(first(row, ["max_guests", "capacity", "max_section_load"]));
      const start = new Date(Date.now() - (days ?? 0) * 86_400_000).toISOString().slice(0, 10);
      if (current === null) { await bindings.database.prepare("INSERT INTO employees(id,first_name,last_name,nickname,role,employment_start_date,active,upsell_score,pitty_score,employment_days,max_section_load,notes,created_at,updated_at) VALUES(?,?,?,?, 'SERVER',?,1,?,?,?,?,NULL,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, firstName, lastName, nickname, start, upsell, pitty, days, capacity).run(); created += 1; }
      else { const changes: string[] = [], values: Array<string | number | null> = []; for (const [field,value] of [["nickname",nickname],["upsell_score",upsell],["pitty_score",pitty],["employment_days",days],["max_section_load",capacity]] as const) if (value !== null) { changes.push(`${field}=?`); values.push(value); } if (days !== null) { changes.push("employment_start_date=?"); values.push(start); } if (changes.length > 0) await bindings.database.prepare(`UPDATE employees SET ${changes.join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...values,id).run(); updated += 1; }
    }
    return jsonResponse(request, { created, updated }, { status: 201 });
  }
  if (url.pathname === "/imports/daily-roster") {
    if (!headers.includes("name")) return apiError(request, 400, rows.length === 0 ? "CSV must include a header row." : "CSV must include a 'name' column."); const date = url.searchParams.get("date"), storeParam = url.searchParams.get("store_id"); if (date === null) return apiError(request, 422, "date is required");
    const store = storeParam === null ? null : Number(storeParam), entries = rows.map((row) => { const name = first(row,["name"]), inTime = first(row,["in_time","In Time"]); return name === null ? null : inTime === null ? { name } : { name, in_time: inTime }; }).filter((entry) => entry !== null);
    const existing = await bindings.database.prepare("SELECT id FROM daily_rosters WHERE date=? AND ((store_id IS NULL AND ? IS NULL) OR store_id=?)").bind(date,store,store).first<{id:number}>(), id = existing?.id ?? randomId();
    if (existing === null) await bindings.database.prepare("INSERT INTO daily_rosters(id,date,store_id,entries,created_at,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id,date,store,jsonText(entries)).run(); else await bindings.database.prepare("UPDATE daily_rosters SET entries=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(jsonText(entries),id).run();
    return jsonResponse(request, { date, store_id: store, count: entries.length }, { status: 201 });
  }
  return apiError(request, 404, "Not Found");
}
