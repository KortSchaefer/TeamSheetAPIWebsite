import { apiError, jsonResponse, methodNotAllowed } from "../http";
import type { RuntimeBindings } from "../runtime";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";
import {
  booleanValue, integerValue, iso, isObject, jsonArray, jsonBody, jsonText, nullableString,
  numberValue, randomId, requiredString, type JsonObject,
} from "./pos-common";

type Row = Record<string, unknown>;

async function authorize(request: Request, bindings: RuntimeBindings, manager: boolean) {
  const auth = await authenticateRequest(request, bindings);
  if (auth.response !== null || auth.user === null || !manager) return auth;
  const denied = requireManagerOrAdmin(request, auth.user.role);
  return denied === null ? auth : { user: null, response: denied };
}

function employee(row: Row): JsonObject {
  return {
    created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), first_name: String(row.first_name),
    last_name: String(row.last_name), nickname: row.nickname ?? null, role: String(row.role), employment_start_date: String(row.employment_start_date),
    active: booleanValue(row.active), upsell_score: row.upsell_score === null ? null : numberValue(row.upsell_score),
    pitty_score: row.pitty_score === null ? null : numberValue(row.pitty_score), employment_days: row.employment_days === null ? null : numberValue(row.employment_days),
    max_section_load: row.max_section_load === null ? null : numberValue(row.max_section_load), notes: row.notes ?? null, id: numberValue(row.id),
  };
}

async function employeeRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/employees")) return null;
  const match = /^\/employees\/(\d+)$/u.exec(url.pathname);
  const manager = request.method !== "GET";
  const auth = await authorize(request, bindings, manager);
  if (auth.response !== null) return auth.response;
  if (url.pathname === "/employees") {
    if (request.method === "GET") {
      const conditions: string[] = [], values: Array<string | number> = [];
      const role = url.searchParams.get("role"), active = url.searchParams.get("active"), search = url.searchParams.get("search");
      if (role !== null) { conditions.push("role=?"); values.push(role); }
      if (active !== null) { conditions.push("active=?"); values.push(active === "true" ? 1 : 0); }
      if (search !== null) { conditions.push("(lower(first_name) LIKE ? OR lower(last_name) LIKE ? OR lower(coalesce(nickname,'')) LIKE ?)"); const pattern = `%${search.toLowerCase()}%`; values.push(pattern, pattern, pattern); }
      const sort = url.searchParams.get("sort_by") === "upsell_score" ? "upsell_score DESC NULLS LAST"
        : url.searchParams.get("sort_by") === "employment_days" ? "employment_days DESC NULLS LAST" : "first_name ASC";
      const result = await bindings.database.prepare(`SELECT * FROM employees ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${sort}`).bind(...values).all<Row>();
      return jsonResponse(request, result.results.map(employee));
    }
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request); if (body instanceof Response) return body;
    const first = requiredString(request, body, "first_name", 100); if (first instanceof Response) return first;
    const last = requiredString(request, body, "last_name", 100); if (last instanceof Response) return last;
    const id = randomId();
    await bindings.database.prepare(
      `INSERT INTO employees(id,first_name,last_name,nickname,role,employment_start_date,active,upsell_score,pitty_score,employment_days,max_section_load,notes,created_at,updated_at)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    ).bind(id, first, last, nullableString(body.nickname), String(body.role), String(body.employment_start_date), booleanValue(body.active) ? 1 : 0,
      body.upsell_score ?? null, body.pitty_score ?? null, body.employment_days ?? null, body.max_section_load ?? null, body.notes ?? null).run();
    const row = await bindings.database.prepare("SELECT * FROM employees WHERE id=?").bind(id).first<Row>();
    return jsonResponse(request, employee(row as Row), { status: 201 });
  }
  if (match === null) return apiError(request, 404, "Not Found");
  const id = Number(match[1]), row = await bindings.database.prepare("SELECT * FROM employees WHERE id=?").bind(id).first<Row>();
  if (row === null) return apiError(request, 404, "Employee not found");
  if (request.method === "GET") return jsonResponse(request, employee(row));
  if (request.method === "DELETE") {
    await bindings.database.prepare("UPDATE employees SET active=0,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(id).run();
    return new Response(null, { status: 204 });
  }
  if (request.method !== "PUT") return methodNotAllowed(request, "DELETE, GET, PUT");
  const body = await jsonBody(request); if (body instanceof Response) return body;
  const fields = ["first_name", "last_name", "nickname", "role", "employment_start_date", "active", "upsell_score", "pitty_score", "employment_days", "max_section_load", "notes"];
  const changes = fields.filter((field) => field in body);
  if (changes.length > 0) {
    const values = changes.map((field) => field === "active" ? (booleanValue(body[field]) ? 1 : 0) : body[field] === undefined ? null : body[field] as string | number | null);
    await bindings.database.prepare(`UPDATE employees SET ${changes.map((field) => `${field}=?`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...values, id).run();
  }
  return jsonResponse(request, employee(await bindings.database.prepare("SELECT * FROM employees WHERE id=?").bind(id).first<Row>() as Row));
}

function section(row: Row): JsonObject {
  return { name: String(row.name), label: String(row.label), type: String(row.type), tables: row.tables === null ? null : jsonArray(row.tables),
    tags: row.tags === null ? null : jsonArray(row.tags), cut_order: row.cut_order === null ? null : numberValue(row.cut_order), sidework: row.sidework ?? null,
    outwork: row.outwork ?? null, max_capacity: row.max_capacity === null ? null : numberValue(row.max_capacity), expected_out_time: row.expected_out_time ?? null,
    max_guests: row.max_guests === null ? null : numberValue(row.max_guests), is_active: booleanValue(row.is_active), id: numberValue(row.id) };
}

async function sectionRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/sections")) return null;
  const auth = await authorize(request, bindings, request.method !== "GET"); if (auth.response !== null) return auth.response;
  if (url.pathname === "/sections") {
    if (request.method === "GET") return jsonResponse(request, (await bindings.database.prepare("SELECT * FROM sections ORDER BY name").all<Row>()).results.map(section));
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request); if (body instanceof Response) return body;
    const name = requiredString(request, body, "name", 100); if (name instanceof Response) return name;
    const label = requiredString(request, body, "label", 100); if (label instanceof Response) return label;
    const id = randomId();
    await bindings.database.prepare(
      `INSERT INTO sections(id,name,label,type,tables,tags,cut_order,sidework,outwork,max_capacity,expected_out_time,max_guests,is_active)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(id, name, label, String(body.type), body.tables === null || body.tables === undefined ? null : jsonText(body.tables),
      body.tags === null || body.tags === undefined ? null : jsonText(body.tags), body.cut_order ?? null, body.sidework ?? null, body.outwork ?? null,
      body.max_capacity ?? null, body.expected_out_time ?? null, body.max_guests ?? null, booleanValue(body.is_active) ? 1 : 0).run();
    return jsonResponse(request, section(await bindings.database.prepare("SELECT * FROM sections WHERE id=?").bind(id).first<Row>() as Row), { status: 201 });
  }
  const match = /^\/sections\/(\d+)$/u.exec(url.pathname); if (match === null) return apiError(request, 404, "Not Found");
  if (request.method !== "PUT") return methodNotAllowed(request, "PUT");
  const id = Number(match[1]), current = await bindings.database.prepare("SELECT * FROM sections WHERE id=?").bind(id).first<Row>();
  if (current === null) return apiError(request, 404, "Section not found");
  const body = await jsonBody(request); if (body instanceof Response) return body;
  const fields = ["name", "label", "type", "tables", "tags", "cut_order", "sidework", "outwork", "max_capacity", "expected_out_time", "max_guests", "is_active"];
  const changes = fields.filter((field) => field in body);
  if (changes.length > 0) await bindings.database.prepare(`UPDATE sections SET ${changes.map((field) => `${field}=?`).join(",")} WHERE id=?`).bind(
    ...changes.map((field) => field === "tables" || field === "tags" ? (body[field] === null ? null : jsonText(body[field])) : field === "is_active" ? (booleanValue(body[field]) ? 1 : 0) : body[field] as string | number | null), id,
  ).run();
  return jsonResponse(request, section(await bindings.database.prepare("SELECT * FROM sections WHERE id=?").bind(id).first<Row>() as Row));
}

function shift(row: Row): JsonObject {
  return { created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), date: String(row.date), time_period: String(row.time_period),
    store_id: row.store_id === null ? null : numberValue(row.store_id), id: numberValue(row.id), created_by_user_id: numberValue(row.created_by_user_id) };
}

async function shiftRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/shifts")) return null;
  const auth = await authorize(request, bindings, request.method === "POST"); if (auth.response !== null) return auth.response;
  if (url.pathname === "/shifts") {
    if (request.method === "GET") {
      const conditions: string[] = [], values: string[] = [];
      for (const [parameter, field, operator] of [["start_date", "date", ">="], ["end_date", "date", "<="], ["time_period", "time_period", "="]] as const) {
        const value = url.searchParams.get(parameter); if (value !== null) { conditions.push(`${field}${operator}?`); values.push(value); }
      }
      const result = await bindings.database.prepare(`SELECT * FROM shifts ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY date DESC`).bind(...values).all<Row>();
      return jsonResponse(request, result.results.map(shift));
    }
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request); if (body instanceof Response) return body;
    const id = randomId();
    await bindings.database.prepare("INSERT INTO shifts(id,date,time_period,store_id,created_by_user_id,created_at,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)")
      .bind(id, String(body.date), String(body.time_period), body.store_id ?? null, auth.user?.id ?? 0).run();
    return jsonResponse(request, shift(await bindings.database.prepare("SELECT * FROM shifts WHERE id=?").bind(id).first<Row>() as Row), { status: 201 });
  }
  const match = /^\/shifts\/(\d+)$/u.exec(url.pathname); if (match === null || request.method !== "GET") return match === null ? apiError(request, 404, "Not Found") : methodNotAllowed(request, "GET");
  const row = await bindings.database.prepare("SELECT * FROM shifts WHERE id=?").bind(Number(match[1])).first<Row>();
  return row === null ? apiError(request, 404, "Shift not found") : jsonResponse(request, shift(row));
}

async function seasonRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/seasons")) return null;
  const auth = await authorize(request, bindings, request.method !== "GET"); if (auth.response !== null) return auth.response;
  if (url.pathname === "/seasons") {
    if (request.method === "GET") return jsonResponse(request, (await bindings.database.prepare("SELECT * FROM seasons ORDER BY year").all<Row>()).results.map((row) => ({ created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), year: numberValue(row.year), start_date: String(row.start_date), id: numberValue(row.id) })));
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request); if (body instanceof Response) return body;
    const year = integerValue(body.year), start = String(body.start_date);
    const existing = await bindings.database.prepare("SELECT id FROM seasons WHERE year=?").bind(year).first<{ id: number }>();
    const id = existing?.id ?? randomId();
    if (existing === null) await bindings.database.prepare("INSERT INTO seasons(id,year,start_date,created_at,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, year, start).run();
    else await bindings.database.prepare("UPDATE seasons SET start_date=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(start, id).run();
    const row = await bindings.database.prepare("SELECT * FROM seasons WHERE id=?").bind(id).first<Row>();
    return jsonResponse(request, { created_at: iso(String(row?.created_at)), updated_at: iso(String(row?.updated_at)), year, start_date: start, id }, { status: 201 });
  }
  const match = /^\/seasons\/(\d+)$/u.exec(url.pathname); if (match === null) return apiError(request, 404, "Not Found");
  if (request.method !== "DELETE") return methodNotAllowed(request, "DELETE");
  const result = await bindings.database.prepare("DELETE FROM seasons WHERE id=? RETURNING id").bind(Number(match[1])).first();
  return result === null ? apiError(request, 404, "Season not found") : new Response(null, { status: 204 });
}

function preference(row: Row): JsonObject {
  return { created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), store_number: String(row.store_number),
    daily_schedule: jsonArray(row.daily_schedule), blast_minimum_percent: numberValue(row.blast_minimum_percent, 98), id: numberValue(row.id) };
}

async function preferenceRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (url.pathname !== "/store-preferences") return null;
  const auth = await authorize(request, bindings, request.method === "POST"); if (auth.response !== null) return auth.response;
  if (request.method === "GET") {
    const store = url.searchParams.get("store_number");
    const result = store === null ? await bindings.database.prepare("SELECT * FROM store_preferences ORDER BY store_number").all<Row>()
      : await bindings.database.prepare("SELECT * FROM store_preferences WHERE store_number=? ORDER BY store_number").bind(store).all<Row>();
    return jsonResponse(request, result.results.map(preference));
  }
  if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
  const body = await jsonBody(request); if (body instanceof Response) return body;
  const store = requiredString(request, body, "store_number", 50); if (store instanceof Response) return store;
  const existing = await bindings.database.prepare("SELECT id FROM store_preferences WHERE store_number=?").bind(store).first<{ id: number }>();
  const id = existing?.id ?? randomId(), schedule = Array.isArray(body.daily_schedule) ? body.daily_schedule : [], blast = Math.max(0, Math.min(250, numberValue(body.blast_minimum_percent, 98)));
  if (existing === null) await bindings.database.prepare("INSERT INTO store_preferences(id,store_number,daily_schedule,blast_minimum_percent,created_at,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, store, jsonText(schedule), blast).run();
  else await bindings.database.prepare("UPDATE store_preferences SET daily_schedule=?,blast_minimum_percent=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(jsonText(schedule), blast, id).run();
  return jsonResponse(request, preference(await bindings.database.prepare("SELECT * FROM store_preferences WHERE id=?").bind(id).first<Row>() as Row));
}

function cobrand(row: Row): JsonObject {
  const sellerName = row.seller_id === null ? null : (`${String(row.first_name ?? "")} ${String(row.last_name ?? "")}`.trim() || (row.nickname ?? null));
  return { created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), company_name: String(row.company_name), amount_usd: numberValue(row.amount_cents) / 100,
    season_year: row.season_year === null ? null : numberValue(row.season_year), date_of_commission: row.date_of_commission ?? null, date_of_payment: row.date_of_payment ?? null,
    date_of_pickup: row.date_of_pickup ?? null, seller_id: row.seller_id === null ? null : numberValue(row.seller_id), logo_base64: row.logo_base64 ?? null,
    id: numberValue(row.id), seller_name: sellerName };
}

async function cobrandRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/cobrands")) return null;
  const auth = await authorize(request, bindings, false); if (auth.response !== null) return auth.response;
  if (url.pathname === "/cobrands/sellers") {
    if (request.method !== "GET") return methodNotAllowed(request, "GET");
    const search = url.searchParams.get("search"), values: string[] = [];
    let filter = "active=1 AND role='SERVER'";
    if (search !== null) { filter += " AND (lower(first_name) LIKE ? OR lower(last_name) LIKE ? OR lower(coalesce(nickname,'')) LIKE ?)"; const pattern = `%${search.toLowerCase()}%`; values.push(pattern, pattern, pattern); }
    const result = await bindings.database.prepare(`SELECT * FROM employees WHERE ${filter} ORDER BY first_name LIMIT 25`).bind(...values).all<Row>();
    return jsonResponse(request, result.results.map((row) => ({ id: numberValue(row.id), name: `${String(row.first_name)} ${String(row.last_name)}`.trim(), role: String(row.role) })));
  }
  if (url.pathname !== "/cobrands") return apiError(request, 404, "Not Found");
  if (request.method === "GET") {
    const allowed = new Set(["company_name", "amount", "date_of_commission", "date_of_payment", "date_of_pickup", "created_at"]);
    const requested = url.searchParams.get("sort_by") ?? "created_at", sort = allowed.has(requested) ? (requested === "amount" ? "amount_cents" : requested) : "created_at";
    const direction = url.searchParams.get("sort_dir")?.toLowerCase() === "asc" ? "ASC" : "DESC", season = url.searchParams.get("season_year");
    const sql = `SELECT c.*,e.first_name,e.last_name,e.nickname FROM cobrand_deals c LEFT JOIN employees e ON e.id=c.seller_id ${season === null ? "" : "WHERE c.season_year=?"} ORDER BY c.${sort} ${direction}`;
    const result = season === null ? await bindings.database.prepare(sql).all<Row>() : await bindings.database.prepare(sql).bind(Number(season)).all<Row>();
    return jsonResponse(request, result.results.map(cobrand));
  }
  if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
  const body = await jsonBody(request); if (body instanceof Response) return body;
  const company = typeof body.company_name === "string" ? body.company_name.trim() : "", amount = numberValue(body.amount_usd);
  if (amount <= 0) return apiError(request, 400, "Amount must be greater than zero");
  if (company.length === 0) return apiError(request, 400, "Company name is required");
  if (body.season_year === null || body.season_year === undefined) return apiError(request, 400, "season_year is required");
  const sellerId = body.seller_id === null || body.seller_id === undefined ? null : integerValue(body.seller_id);
  if (sellerId !== null && (await bindings.database.prepare("SELECT id FROM employees WHERE id=? AND active=1").bind(sellerId).first()) === null) return apiError(request, 404, "Seller not found");
  const id = randomId();
  await bindings.database.prepare(
    `INSERT INTO cobrand_deals(id,company_name,amount_cents,date_of_commission,date_of_payment,date_of_pickup,seller_id,logo_base64,season_year,created_at,updated_at)
     VALUES(?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
  ).bind(id, company, Math.round(amount * 100), body.date_of_commission ?? null, body.date_of_payment ?? null, body.date_of_pickup ?? null, sellerId, body.logo_base64 ?? null, integerValue(body.season_year)).run();
  const row = await bindings.database.prepare("SELECT c.*,e.first_name,e.last_name,e.nickname FROM cobrand_deals c LEFT JOIN employees e ON e.id=c.seller_id WHERE c.id=?").bind(id).first<Row>();
  return jsonResponse(request, cobrand(row as Row), { status: 201 });
}

async function rosterOrPresetRoutes(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  const roster = url.pathname === "/daily-rosters", preset = url.pathname === "/teamsheet-presets";
  if (!roster && !preset) return null;
  const auth = await authorize(request, bindings, request.method === "POST"); if (auth.response !== null) return auth.response;
  const table = roster ? "daily_rosters" : "teamsheet_presets";
  if (request.method === "GET") {
    const conditions: string[] = [], values: Array<string | number> = [];
    const date = url.searchParams.get("date"), store = url.searchParams.get("store_id");
    if (roster && date !== null) { conditions.push("date=?"); values.push(date); }
    if (store !== null) { conditions.push("store_id=?"); values.push(Number(store)); }
    const result = await bindings.database.prepare(`SELECT * FROM ${table} ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY ${roster ? "date DESC" : "name"}`).bind(...values).all<Row>();
    return jsonResponse(request, result.results.map((row) => roster
      ? { created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), date: String(row.date), store_id: row.store_id === null ? null : numberValue(row.store_id), entries: jsonArray(row.entries), id: numberValue(row.id) }
      : { created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)), name: String(row.name), store_id: row.store_id === null ? null : numberValue(row.store_id), data_json: jsonArray(row.data_json), id: numberValue(row.id) }));
  }
  if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
  const body = await jsonBody(request); if (body instanceof Response) return body;
  const storeId = body.store_id === null || body.store_id === undefined ? null : integerValue(body.store_id);
  const key = roster ? String(body.date) : String(body.name), keyColumn = roster ? "date" : "name", dataColumn = roster ? "entries" : "data_json";
  const existing = await bindings.database.prepare(`SELECT id FROM ${table} WHERE ${keyColumn}=? AND ((store_id IS NULL AND ? IS NULL) OR store_id=?)`).bind(key, storeId, storeId).first<{ id: number }>();
  const id = existing?.id ?? randomId(), data = Array.isArray(body[dataColumn]) ? body[dataColumn] : [];
  if (existing === null) await bindings.database.prepare(`INSERT INTO ${table}(id,${keyColumn},store_id,${dataColumn},created_at,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(id, key, storeId, jsonText(data)).run();
  else await bindings.database.prepare(`UPDATE ${table} SET ${dataColumn}=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(jsonText(data), id).run();
  const row = await bindings.database.prepare(`SELECT * FROM ${table} WHERE id=?`).bind(id).first<Row>();
  return jsonResponse(request, roster
    ? { created_at: iso(String(row?.created_at)), updated_at: iso(String(row?.updated_at)), date: key, store_id: storeId, entries: data, id }
    : { created_at: iso(String(row?.created_at)), updated_at: iso(String(row?.updated_at)), name: key, store_id: storeId, data_json: data, id }, { status: 201 });
}

export async function routeWorkforce(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  return await employeeRoutes(request, url, bindings)
    ?? await sectionRoutes(request, url, bindings)
    ?? await shiftRoutes(request, url, bindings)
    ?? await seasonRoutes(request, url, bindings)
    ?? await preferenceRoutes(request, url, bindings)
    ?? await cobrandRoutes(request, url, bindings)
    ?? await rosterOrPresetRoutes(request, url, bindings);
}
