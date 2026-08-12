import { apiError, validationError } from "../http";
import type { RuntimeBindings } from "../runtime";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";

export type JsonObject = Record<string, unknown>;

export interface AuthorizedUser {
  id: number;
  role: "ADMIN" | "MANAGER" | "SERVER";
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function jsonBody(request: Request): Promise<JsonObject | Response> {
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

export function requiredString(
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

export function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function integerValue(value: unknown, fallback = 0): number {
  const parsed = numberValue(value, fallback);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

export function booleanValue(value: unknown, fallback = true): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  return value === undefined ? fallback : Boolean(value);
}

export function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function jsonValue(value: unknown, fallback: unknown = {}): unknown {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return fallback;
  }
}

export function jsonObject(value: unknown): JsonObject {
  const parsed = jsonValue(value);
  return isObject(parsed) ? parsed : {};
}

export function jsonArray(value: unknown): unknown[] {
  const parsed = jsonValue(value, []);
  return Array.isArray(parsed) ? parsed : [];
}

export function jsonText(value: unknown): string {
  return JSON.stringify(value ?? {});
}

export function iso(value: string | null): string | null {
  return value === null || value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
}

export function randomId(): number {
  const values = crypto.getRandomValues(new Uint32Array(1));
  return (values[0] & 0x7fffffff) || 1;
}

export function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "") || "item";
}

export function slugIsValid(value: string): boolean {
  return /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
}

export async function requireUser(
  request: Request,
  bindings: RuntimeBindings,
): Promise<{ user: AuthorizedUser | null; response: Response | null }> {
  const authentication = await authenticateRequest(request, bindings);
  return {
    user: authentication.user === null
      ? null
      : { id: authentication.user.id, role: authentication.user.role },
    response: authentication.response,
  };
}

export async function requireManager(
  request: Request,
  bindings: RuntimeBindings,
): Promise<{ user: AuthorizedUser | null; response: Response | null }> {
  const authentication = await authenticateRequest(request, bindings);
  if (authentication.response !== null || authentication.user === null) {
    return { user: null, response: authentication.response };
  }
  const denied = requireManagerOrAdmin(request, authentication.user.role);
  return denied === null
    ? { user: { id: authentication.user.id, role: authentication.user.role }, response: null }
    : { user: null, response: denied };
}

export async function rowExists(
  database: D1Database,
  table: string,
  id: number,
): Promise<boolean> {
  const allowed = new Set([
    "employees", "ingredients", "menu_categories", "menu_items", "pos_pages", "pos_buttons",
    "pos_tags", "pos_modifier_groups", "pos_prompts", "pos_behavior_rules", "pos_orders", "pos_tables",
  ]);
  if (!allowed.has(table)) throw new Error(`Unsafe POS table lookup: ${table}`);
  return (await database.prepare(`SELECT id FROM ${table} WHERE id = ? LIMIT 1`).bind(id).first()) !== null;
}

export async function requireExisting(
  request: Request,
  database: D1Database,
  table: string,
  id: number,
  label: string,
): Promise<Response | null> {
  return await rowExists(database, table, id) ? null : apiError(request, 404, `${label} not found`);
}

export async function recordPOSAudit(
  database: D1Database,
  actorUserId: number,
  action: string,
  entityType: string,
  entityId: number | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  await database.prepare(
    `INSERT INTO pos_config_audit
     (id, actor_user_id, action, entity_type, entity_id, before_value, after_value, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
  ).bind(
    randomId(),
    actorUserId,
    action,
    entityType,
    entityId,
    before === null ? null : jsonText(before),
    after === null ? null : jsonText(after),
  ).run();
}

export function constraintResponse(request: Request, error: unknown): Response | null {
  if (!(error instanceof Error) || !/unique|constraint/iu.test(error.message)) return null;
  return apiError(request, 409, "A POS record with that key already exists");
}
