import { apiError, jsonResponse, methodNotAllowed } from "../http";
import type { RuntimeBindings } from "../runtime";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";
import { booleanValue, iso, isObject, jsonArray, jsonBody, jsonValue, numberValue, randomId, type JsonObject } from "./pos-common";

type Row = Record<string, unknown>;

async function authorize(request: Request, bindings: RuntimeBindings, manager: boolean) {
  const auth = await authenticateRequest(request, bindings);
  if (auth.response !== null || auth.user === null || !manager) return auth;
  const denied = requireManagerOrAdmin(request, auth.user.role);
  return denied === null ? auth : { user: null, response: denied };
}

function timestamps(row: Row): JsonObject { return { created_at: iso(String(row.created_at)), updated_at: iso(String(row.updated_at)) }; }
function gift(row: Row): JsonObject {
  return { ...timestamps(row), employee_name: String(row.employee_name), season_year: row.season_year === null ? null : numberValue(row.season_year),
    tuesday: numberValue(row.tuesday), wednesday: numberValue(row.wednesday), thursday: numberValue(row.thursday), friday: numberValue(row.friday),
    saturday: numberValue(row.saturday), sunday: numberValue(row.sunday), monday: numberValue(row.monday), id: numberValue(row.id), week_number: numberValue(row.week_number) };
}

export async function routeGiftTracker(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (url.pathname !== "/gift-tracker") return null;
  const auth = await authorize(request, bindings, request.method === "POST"); if (auth.response !== null) return auth.response;
  if (request.method === "GET") {
    const conditions: string[] = [], values: number[] = [];
    for (const field of ["week_number", "season_year"] as const) { const value = url.searchParams.get(field); if (value !== null) { conditions.push(`${field}=?`); values.push(Number(value)); } }
    const result = await bindings.database.prepare(`SELECT * FROM gift_tracker_entries ${conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""} ORDER BY week_number,employee_name`).bind(...values).all<Row>();
    return jsonResponse(request, result.results.map(gift));
  }
  if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
  const body = await jsonBody(request); if (body instanceof Response) return body;
  const week = Number(body.week_number), season = body.season_year === null || body.season_year === undefined ? null : Number(body.season_year), entries = body.entries;
  if (!Number.isInteger(week) || week < 1) return apiError(request, 400, "Week number must be at least 1");
  if (!Array.isArray(entries) || entries.some((entry) => !isObject(entry) || typeof entry.employee_name !== "string" || entry.employee_name.trim().length === 0)) return apiError(request, 422, "Invalid gift tracker entries");
  const existing = await bindings.database.prepare("SELECT id,lower(employee_name) AS name FROM gift_tracker_entries WHERE week_number=? AND ((season_year IS NULL AND ? IS NULL) OR season_year=?)").bind(week, season, season).all<{ id: number; name: string }>();
  const ids = new Map(existing.results.map((row) => [row.name, row.id])), seen = new Set<string>(), statements: D1PreparedStatement[] = [];
  for (const raw of entries) {
    const entry = raw as JsonObject, name = String(entry.employee_name).trim(), key = name.toLowerCase(), id = ids.get(key) ?? randomId(); seen.add(key);
    const days = ["tuesday", "wednesday", "thursday", "friday", "saturday", "sunday", "monday"].map((day) => numberValue(entry[day]));
    if (ids.has(key)) statements.push(bindings.database.prepare("UPDATE gift_tracker_entries SET tuesday=?,wednesday=?,thursday=?,friday=?,saturday=?,sunday=?,monday=?,updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(...days, id));
    else statements.push(bindings.database.prepare("INSERT INTO gift_tracker_entries(id,employee_name,week_number,season_year,tuesday,wednesday,thursday,friday,saturday,sunday,monday,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, name, week, season, ...days));
  }
  for (const [name, id] of ids) if (!seen.has(name)) statements.push(bindings.database.prepare("DELETE FROM gift_tracker_entries WHERE id=?").bind(id));
  if (statements.length > 0) await bindings.database.batch(statements);
  const result = await bindings.database.prepare("SELECT * FROM gift_tracker_entries WHERE week_number=? AND ((season_year IS NULL AND ? IS NULL) OR season_year=?) ORDER BY employee_name").bind(week, season, season).all<Row>();
  return jsonResponse(request, result.results.map(gift), { status: 201 });
}

type CrudKind = "tiers" | "rules" | "prizes";
const CRUD = {
  tiers: { table: "payout_tiers", fields: ["label", "season_year", "min_amount_cents", "max_amount_cents", "payout_type", "payout_value", "active"], order: "min_amount_cents ASC", missing: "Tier not found" },
  rules: { table: "payout_rules", fields: ["name", "type", "season_year", "config", "active"], order: "created_at DESC", missing: "Rule not found" },
  prizes: { table: "prizes", fields: ["name", "season_year", "description", "cost_cents", "image_url", "active"], order: "created_at DESC", missing: "Prize not found" },
} as const;

function payoutObject(kind: CrudKind, row: Row): JsonObject {
  const base: JsonObject = { ...timestamps(row), id: numberValue(row.id) };
  for (const field of CRUD[kind].fields) {
    if (field === "active") base[field] = booleanValue(row[field]);
    else if (field === "config") base[field] = row[field] === null ? null : jsonValue(row[field], null);
    else base[field] = row[field] ?? null;
  }
  return base;
}

async function crudRoute(request: Request, url: URL, bindings: RuntimeBindings, kind: CrudKind): Promise<Response | null> {
  const base = `/payouts/${kind}`, match = new RegExp(`^${base}/(\\d+)$`, "u").exec(url.pathname);
  if (url.pathname !== base && match === null) return null;
  const auth = await authorize(request, bindings, request.method !== "GET"); if (auth.response !== null) return auth.response;
  const spec = CRUD[kind];
  if (url.pathname === base) {
    if (request.method === "GET") {
      const season = url.searchParams.get("season_year"), query = `SELECT * FROM ${spec.table} ${season === null ? "" : "WHERE season_year=?"} ORDER BY ${spec.order}`;
      const rows = season === null ? await bindings.database.prepare(query).all<Row>() : await bindings.database.prepare(query).bind(Number(season)).all<Row>();
      return jsonResponse(request, rows.results.map((row) => payoutObject(kind, row)));
    }
    if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
    const body = await jsonBody(request); if (body instanceof Response) return body; const id = randomId();
    await bindings.database.prepare(`INSERT INTO ${spec.table}(id,${spec.fields.join(",")},created_at,updated_at) VALUES(?,${spec.fields.map(() => "?").join(",")},CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`).bind(id, ...spec.fields.map((field) => field === "active" ? (booleanValue(body[field]) ? 1 : 0) : field === "config" ? (body[field] ? JSON.stringify(body[field]) : null) : body[field] ?? null)).run();
    return jsonResponse(request, payoutObject(kind, await bindings.database.prepare(`SELECT * FROM ${spec.table} WHERE id=?`).bind(id).first<Row>() as Row), { status: 201 });
  }
  const id = Number(match?.[1]), current = await bindings.database.prepare(`SELECT * FROM ${spec.table} WHERE id=?`).bind(id).first<Row>(); if (current === null) return apiError(request, 404, spec.missing);
  if (request.method === "DELETE") { await bindings.database.prepare(`DELETE FROM ${spec.table} WHERE id=?`).bind(id).run(); return new Response(null, { status: 204 }); }
  if (request.method !== "PUT") return methodNotAllowed(request, "DELETE, PUT");
  const body = await jsonBody(request); if (body instanceof Response) return body;
  await bindings.database.prepare(`UPDATE ${spec.table} SET ${spec.fields.map((field) => `${field}=?`).join(",")},updated_at=CURRENT_TIMESTAMP WHERE id=?`).bind(...spec.fields.map((field) => field === "active" ? (booleanValue(body[field]) ? 1 : 0) : field === "config" ? (body[field] ? JSON.stringify(body[field]) : null) : body[field] ?? null), id).run();
  return jsonResponse(request, payoutObject(kind, await bindings.database.prepare(`SELECT * FROM ${spec.table} WHERE id=?`).bind(id).first<Row>() as Row));
}

function prize(row: Row): JsonObject { return payoutObject("prizes", row); }
function assignment(row: Row): JsonObject { return { ...timestamps(row), employee_name: String(row.employee_name), prize_id: numberValue(row.prize_id), season_year: row.season_year === null ? null : numberValue(row.season_year), notes: row.notes ?? null, id: numberValue(row.id), prize: row.prize_name === undefined ? undefined : prize({ id: row.prize_id, name: row.prize_name, season_year: row.prize_season_year, description: row.prize_description, cost_cents: row.prize_cost_cents, image_url: row.prize_image_url, active: row.prize_active, created_at: row.prize_created_at, updated_at: row.prize_updated_at }) }; }
function adjustment(row: Row): JsonObject { return { ...timestamps(row), employee_name: String(row.employee_name), label: String(row.label), season_year: row.season_year === null ? null : numberValue(row.season_year), amount_cents: numberValue(row.amount_cents), id: numberValue(row.id) }; }

async function listOrCreate(request: Request, url: URL, bindings: RuntimeBindings, kind: "assign" | "adjustments"): Promise<Response | null> {
  const path = kind === "assign" ? "/payouts/prizes/assign" : "/payouts/adjustments"; if (url.pathname !== path) return null;
  const auth = await authorize(request, bindings, request.method === "POST"); if (auth.response !== null) return auth.response;
  const table = kind === "assign" ? "prize_assignments" : "payout_adjustments";
  if (request.method === "GET") {
    const season = url.searchParams.get("season_year");
    const select = kind === "assign" ? `SELECT a.*,p.name prize_name,p.season_year prize_season_year,p.description prize_description,p.cost_cents prize_cost_cents,p.image_url prize_image_url,p.active prize_active,p.created_at prize_created_at,p.updated_at prize_updated_at FROM prize_assignments a LEFT JOIN prizes p ON p.id=a.prize_id` : "SELECT * FROM payout_adjustments";
    const sql = `${select} ${season === null ? "" : kind === "assign" ? "WHERE a.season_year=?" : "WHERE season_year=?"} ORDER BY ${kind === "assign" ? "a.created_at" : "created_at"} DESC`, result = season === null ? await bindings.database.prepare(sql).all<Row>() : await bindings.database.prepare(sql).bind(Number(season)).all<Row>();
    return jsonResponse(request, result.results.map(kind === "assign" ? assignment : adjustment));
  }
  if (request.method !== "POST") return methodNotAllowed(request, "GET, POST");
  const body = await jsonBody(request); if (body instanceof Response) return body; const id = randomId();
  if (kind === "assign") {
    if (await bindings.database.prepare("SELECT id FROM prizes WHERE id=?").bind(Number(body.prize_id)).first() === null) return apiError(request, 404, "Prize not found");
    await bindings.database.prepare("INSERT INTO prize_assignments(id,employee_name,prize_id,season_year,notes,created_at,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, String(body.employee_name), Number(body.prize_id), body.season_year ?? null, body.notes ?? null).run();
    const row = await bindings.database.prepare("SELECT a.*,p.name prize_name,p.season_year prize_season_year,p.description prize_description,p.cost_cents prize_cost_cents,p.image_url prize_image_url,p.active prize_active,p.created_at prize_created_at,p.updated_at prize_updated_at FROM prize_assignments a LEFT JOIN prizes p ON p.id=a.prize_id WHERE a.id=?").bind(id).first<Row>();
    return jsonResponse(request, assignment(row as Row), { status: 201 });
  }
  await bindings.database.prepare("INSERT INTO payout_adjustments(id,employee_name,label,season_year,amount_cents,created_at,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)").bind(id, String(body.employee_name), String(body.label), body.season_year ?? null, numberValue(body.amount_cents)).run();
  return jsonResponse(request, adjustment(await bindings.database.prepare("SELECT * FROM payout_adjustments WHERE id=?").bind(id).first<Row>() as Row), { status: 201 });
}

async function payoutSummary(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (url.pathname !== "/payouts/summary") return null; const auth = await authorize(request, bindings, false); if (auth.response !== null) return auth.response;
  if (request.method !== "GET") return methodNotAllowed(request, "GET"); const season = url.searchParams.get("season_year"), seasonValue = season === null ? null : Number(season);
  const condition = season === null ? "" : "WHERE season_year=?", activeCondition = season === null ? "WHERE active=1" : "WHERE active=1 AND season_year=?";
  const query = async (sql: string) => season === null ? bindings.database.prepare(sql).all<Row>() : bindings.database.prepare(sql).bind(seasonValue).all<Row>();
  const [gifts, cobrands, tiers, rules, prizeRows, adjustments] = await Promise.all([
    query(`SELECT * FROM gift_tracker_entries ${condition}`), query(`SELECT c.*,e.first_name,e.last_name,e.nickname FROM cobrand_deals c LEFT JOIN employees e ON e.id=c.seller_id ${season === null ? "" : "WHERE c.season_year=?"}`),
    query(`SELECT * FROM payout_tiers ${activeCondition} ORDER BY min_amount_cents`), query(`SELECT * FROM payout_rules ${activeCondition}`),
    query(`SELECT a.*,p.name prize_name,p.season_year prize_season_year,p.description prize_description,p.cost_cents prize_cost_cents,p.image_url prize_image_url,p.active prize_active,p.created_at prize_created_at,p.updated_at prize_updated_at FROM prize_assignments a JOIN prizes p ON p.id=a.prize_id ${season === null ? "" : "WHERE a.season_year=?"}`), query(`SELECT * FROM payout_adjustments ${condition}`),
  ]);
  const sales = new Map<string, number>(), add = (name: string, amount: number) => sales.set(name, (sales.get(name) ?? 0) + amount);
  for (const row of gifts.results) add(String(row.employee_name), ["tuesday","wednesday","thursday","friday","saturday","sunday","monday"].reduce((sum, day) => sum + numberValue(row[day]), 0) * 100);
  for (const row of cobrands.results) { const name = `${String(row.first_name ?? "")} ${String(row.last_name ?? "")}`.trim() || String(row.nickname ?? ""); if (name) add(name, numberValue(row.amount_cents)); }
  const prizeMap = new Map<string, Row[]>(), adjustmentMap = new Map<string, number>();
  for (const row of prizeRows.results) prizeMap.set(String(row.employee_name), [...(prizeMap.get(String(row.employee_name)) ?? []), row]);
  for (const row of adjustments.results) adjustmentMap.set(String(row.employee_name), (adjustmentMap.get(String(row.employee_name)) ?? 0) + numberValue(row.amount_cents));
  const bonus = new Map<string, number>(), sorted = [...sales].sort((a,b) => b[1]-a[1]);
  for (const row of rules.results) if (String(row.type) === "season_top_seller") { const config = isObject(jsonValue(row.config, {})) ? jsonValue(row.config, {}) as JsonObject : {}; if (sorted[0]) bonus.set(sorted[0][0], Math.round(sorted[0][1] * numberValue(config.first_pct, 10) / 100)); if (sorted[1]) bonus.set(sorted[1][0], Math.round(sorted[1][1] * numberValue(config.second_pct, 5) / 100)); }
  const rows = [...sales].map(([name, total]) => { const tier = tiers.results.find((item) => total >= numberValue(item.min_amount_cents) && (item.max_amount_cents === null || total <= numberValue(item.max_amount_cents))); const tierPayout = tier === undefined ? 0 : String(tier.payout_type) === "FIXED" ? numberValue(tier.payout_value) : Math.round(total * numberValue(tier.payout_value) / 10000); const prizes = prizeMap.get(name) ?? [], prizeValue = prizes.reduce((sum, item) => sum + numberValue(item.prize_cost_cents), 0), misc = adjustmentMap.get(name) ?? 0, rule = bonus.get(name) ?? 0; return { employee_name: name, sales_total_cents: total, tier_payout_cents: tierPayout, rule_payout_cents: rule, misc_cents: misc, prize_value_cents: prizeValue, total_payout_cents: tierPayout + rule + misc + prizeValue, prizes: prizes.map((item) => assignment(item).prize) }; });
  return jsonResponse(request, { rows });
}

export async function routePayouts(request: Request, url: URL, bindings: RuntimeBindings): Promise<Response | null> {
  if (!url.pathname.startsWith("/payouts/")) return null;
  return await listOrCreate(request, url, bindings, "assign") ?? await listOrCreate(request, url, bindings, "adjustments") ?? await payoutSummary(request, url, bindings)
    ?? await crudRoute(request, url, bindings, "tiers") ?? await crudRoute(request, url, bindings, "rules") ?? await crudRoute(request, url, bindings, "prizes");
}
