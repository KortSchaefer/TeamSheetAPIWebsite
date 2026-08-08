import { apiError, jsonResponse, methodNotAllowed, validationError } from "../http";
import type { RuntimeBindings } from "../runtime";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";
import { createXlsx, XLSX_CONTENT_TYPE } from "../xlsx";

type JsonObject = Record<string, unknown>;

interface VoiceSessionRow {
  id: number;
  client_session_id: string;
  manager_user_id: number;
  status: string;
  current_location_id: number;
  current_location_name: string;
  started_at: string;
  finished_at: string | null;
  last_client_sequence: number;
  transcription_model: string;
  normalization_model: string;
  prompt_version: string;
  manager_full_name: string;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function iso(value: unknown): unknown {
  return typeof value === "string" && !value.includes("T") ? value.replace(" ", "T") : value;
}

function numberValue(value: unknown, fallback = 0): number {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function randomId(): number {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff;
  return value || 1;
}

async function body(request: Request): Promise<JsonObject | Response> {
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    return validationError(request, [{ type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {} }]);
  }
  return isObject(value)
    ? value
    : validationError(request, [{ type: "model_attributes_type", loc: ["body"], msg: "Input should be a valid dictionary or object", input: value }]);
}

async function manager(request: Request, bindings: RuntimeBindings) {
  const auth = await authenticateRequest(request, bindings);
  if (auth.response !== null || auth.user === null) return auth;
  const denied = requireManagerOrAdmin(request, auth.user.role);
  return denied === null ? auth : { user: null, response: denied };
}

async function ownedSession(
  request: Request,
  bindings: RuntimeBindings,
  sessionId: number,
) {
  const auth = await manager(request, bindings);
  if (auth.response !== null || auth.user === null) {
    return { auth, session: null, response: auth.response };
  }
  const session = await bindings.database.prepare(
    `SELECT s.id, s.client_session_id, s.manager_user_id, s.status,
      s.current_location_id, l.name AS current_location_name, s.started_at,
      s.finished_at, s.last_client_sequence, s.transcription_model,
      s.normalization_model, s.prompt_version, u.full_name AS manager_full_name
     FROM inventory_voice_sessions s
     JOIN inventory_locations l ON l.id = s.current_location_id
     JOIN users u ON u.id=s.manager_user_id
     WHERE s.id = ?`,
  ).bind(sessionId).first<VoiceSessionRow>();
  if (session === null) return { auth, session: null, response: apiError(request, 404, "Voice inventory session not found") };
  if (session.manager_user_id !== auth.user.id) {
    return { auth, session: null, response: apiError(request, 403, "This voice session belongs to another manager") };
  }
  return { auth, session, response: null };
}

async function sessionEntries(database: D1Database, sessionId: number): Promise<JsonObject[]> {
  const result = await database.prepare(
    `SELECT e.id, e.utterance_id, e.location_id, l.name AS location_name,
      e.inventory_item_id, i.name AS item_name, e.action, e.spoken_item,
      e.spoken_quantity, e.spoken_unit, e.normalized_quantity, i.base_unit,
      e.evidence, e.ambiguity_reason, e.review_status, e.supersedes_entry_id,u.transcript,
      e.created_at
     FROM inventory_voice_entries e
     JOIN inventory_locations l ON l.id = e.location_id
     LEFT JOIN inventory_items i ON i.id = e.inventory_item_id
     JOIN inventory_voice_utterances u ON u.id=e.utterance_id
     WHERE e.session_id = ? ORDER BY e.id`,
  ).bind(sessionId).all<Record<string, unknown>>();
  return result.results.map((row) => ({ ...row, created_at: iso(row.created_at) }));
}

function effectiveCounts(entries: JsonObject[]): JsonObject[] {
  const effective = new Map<string, JsonObject>();
  for (const entry of entries) {
    if (!["AUTO_ACCEPTED", "CORRECTED"].includes(String(entry.review_status)) || entry.inventory_item_id === null) continue;
    const key = `${entry.location_id}:${entry.inventory_item_id}`;
    const current = effective.get(key);
    const amount = numberValue(entry.normalized_quantity);
    const action = String(entry.action);
    if (action === "REMOVE") {
      effective.delete(key);
      continue;
    }
    const quantity = action === "ADD" ? numberValue(current?.quantity) + amount : amount;
    effective.set(key, {
      location_id: entry.location_id,
      location_name: entry.location_name,
      inventory_item_id: entry.inventory_item_id,
      item_name: entry.item_name,
      quantity,
      base_unit: entry.base_unit,
      source_entry_ids: [...((current?.source_entry_ids as number[] | undefined) ?? []), numberValue(entry.id)],
    });
  }
  return [...effective.values()].sort((a, b) => String(a.location_name).localeCompare(String(b.location_name)) || String(a.item_name).localeCompare(String(b.item_name)));
}

async function serializeSession(database: D1Database, session: VoiceSessionRow): Promise<JsonObject> {
  const entries = await sessionEntries(database, session.id);
  const links = await database.prepare(
    `SELECT c.location_id, l.name AS location_name, c.inventory_count_id, i.status
     FROM inventory_voice_session_counts c
     JOIN inventory_locations l ON l.id = c.location_id
     JOIN inventory_counts i ON i.id = c.inventory_count_id
     WHERE c.session_id = ? ORDER BY l.name`,
  ).bind(session.id).all<Record<string, unknown>>();
  return {
    id: session.id,
    client_session_id: session.client_session_id,
    manager_user_id: session.manager_user_id,
    status: session.status,
    current_location_id: session.current_location_id,
    current_location_name: session.current_location_name,
    started_at: iso(session.started_at),
    finished_at: iso(session.finished_at),
    last_client_sequence: session.last_client_sequence,
    transcription_model: session.transcription_model,
    normalization_model: session.normalization_model,
    prompt_version: session.prompt_version,
    blocking_review_count: entries.filter((entry) => entry.review_status === "NEEDS_REVIEW").length,
    entries,
    effective_counts: effectiveCounts(entries),
    draft_counts: links.results,
  };
}

async function readSessionRow(database: D1Database, sessionId: number): Promise<VoiceSessionRow | null> {
  return database.prepare(
    `SELECT s.id, s.client_session_id, s.manager_user_id, s.status,
      s.current_location_id, l.name AS current_location_name, s.started_at,
      s.finished_at, s.last_client_sequence, s.transcription_model,
      s.normalization_model, s.prompt_version, u.full_name AS manager_full_name
     FROM inventory_voice_sessions s JOIN inventory_locations l ON l.id = s.current_location_id JOIN users u ON u.id=s.manager_user_id
     WHERE s.id = ?`,
  ).bind(sessionId).first<VoiceSessionRow>();
}

async function active(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await manager(request, bindings);
  if (auth.response !== null || auth.user === null) return auth.response ?? apiError(request, 401, "Could not validate credentials");
  const session = await bindings.database.prepare(
    `SELECT s.id, s.client_session_id, s.manager_user_id, s.status,
      s.current_location_id, l.name AS current_location_name, s.started_at,
      s.finished_at, s.last_client_sequence, s.transcription_model,
      s.normalization_model, s.prompt_version, u.full_name AS manager_full_name
     FROM inventory_voice_sessions s JOIN inventory_locations l ON l.id = s.current_location_id JOIN users u ON u.id=s.manager_user_id
     WHERE s.manager_user_id = ? AND s.status IN
       ('CREATED','LISTENING','PAUSED','OFFLINE','NEEDS_REVIEW')
     ORDER BY s.created_at DESC, s.id DESC LIMIT 1`,
  ).bind(auth.user.id).first<VoiceSessionRow>();
  return jsonResponse(request, session === null ? null : await serializeSession(bindings.database, session));
}

async function createSession(request: Request, bindings: RuntimeBindings): Promise<Response> {
  const auth = await manager(request, bindings);
  if (auth.response !== null || auth.user === null) return auth.response ?? apiError(request, 401, "Could not validate credentials");
  const input = await body(request);
  if (input instanceof Response) return input;
  const clientId = typeof input.client_session_id === "string" ? input.client_session_id : "";
  const locationId = numberValue(input.initial_location_id);
  if (clientId.length < 8 || clientId.length > 36) return apiError(request, 422, "client_session_id must contain 8 to 36 characters");
  const location = await bindings.database.prepare("SELECT id FROM inventory_locations WHERE id = ? AND active = 1")
    .bind(locationId).first();
  if (location === null) return apiError(request, 404, "Inventory location not found");
  const metadata = isObject(input.device_metadata) ? input.device_metadata : {};
  const requestedCountId = numberValue(input.inventory_count_id ?? metadata.target_count_id);
  if (requestedCountId > 0) {
    const target = await bindings.database.prepare(
      `SELECT c.id, c.status, sc.session_id
       FROM inventory_counts c
       LEFT JOIN inventory_voice_session_counts sc ON sc.inventory_count_id = c.id
       WHERE c.id = ? AND c.location_id = ? AND c.status IN ('DRAFT','SUBMITTED')`,
    ).bind(requestedCountId, locationId).first<{ id: number; status: string; session_id: number | null }>();
    if (target === null) return apiError(request, 404, "Linked inventory count not found");
    if (target.session_id !== null) {
      const linkedSession = await readSessionRow(bindings.database, target.session_id);
      if (linkedSession === null) return apiError(request, 409, "This inventory count already has a voice session");
      if (linkedSession.manager_user_id !== auth.user.id) {
        return apiError(request, 409, "This inventory count is linked to another manager's voice session");
      }
      return jsonResponse(request, await serializeSession(bindings.database, linkedSession), { status: 201 });
    }
  }
  const existing = await bindings.database.prepare(
    `SELECT id FROM inventory_voice_sessions WHERE client_session_id = ? AND manager_user_id = ?`,
  ).bind(clientId, auth.user.id).first<{ id: number }>();
  if (existing !== null) {
    const row = await readSessionRow(bindings.database, existing.id);
    if (row === null) throw new Error("Existing voice session disappeared");
    return jsonResponse(request, await serializeSession(bindings.database, row), { status: 201 });
  }
  const id = randomId();
  const retention = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  await bindings.database.prepare(
    `INSERT INTO inventory_voice_sessions
     (id, client_session_id, manager_user_id, status, current_location_id,
      started_at, finished_at, last_client_sequence, device_metadata,
      transcription_model, normalization_model, prompt_version,
      audio_delete_after, error_message, created_at, updated_at)
     VALUES (?, ?, ?, 'CREATED', ?, CURRENT_TIMESTAMP, NULL, 0, ?,
      'gpt-4o-transcribe', ?, 'voice-inventory-v1',
      ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(id, clientId, auth.user.id, locationId,
    input.device_metadata === undefined ? null : JSON.stringify(input.device_metadata), bindings.openaiNormalizationModel, retention).run();
  if (requestedCountId > 0) {
    await bindings.database.prepare(
      `INSERT INTO inventory_voice_session_counts
       (id, session_id, location_id, inventory_count_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(randomId(), id, locationId, requestedCountId).run();
  }
  const row = await readSessionRow(bindings.database, id);
  if (row === null) throw new Error("Voice session insert returned no row");
  return jsonResponse(request, await serializeSession(bindings.database, row), { status: 201 });
}

async function readSession(request: Request, sessionId: number, bindings: RuntimeBindings): Promise<Response> {
  const owned = await ownedSession(request, bindings, sessionId);
  if (owned.response !== null || owned.session === null) return owned.response ?? apiError(request, 404, "Voice inventory session not found");
  return jsonResponse(request, await serializeSession(bindings.database, owned.session));
}

async function stateChange(
  request: Request,
  sessionId: number,
  status: string,
  bindings: RuntimeBindings,
): Promise<Response> {
  const owned = await ownedSession(request, bindings, sessionId);
  if (owned.response !== null || owned.session === null) return owned.response ?? apiError(request, 404, "Voice inventory session not found");
  if (["FINISHED", "ABANDONED"].includes(owned.session.status)) return apiError(request, 409, "Voice inventory session is already closed");
  if (status === "ABANDONED") {
    const locked = await bindings.database.prepare(
      `SELECT 1 FROM inventory_voice_session_counts sc
       JOIN inventory_counts c ON c.id=sc.inventory_count_id
       WHERE sc.session_id=? AND c.status!='DRAFT' LIMIT 1`,
    ).bind(sessionId).first();
    if (locked !== null) return apiError(request, 409, "A session with submitted counts cannot be abandoned");
  }
  await bindings.database.prepare(
    `UPDATE inventory_voice_sessions SET status = ?,
      finished_at = CASE WHEN ?='ABANDONED' THEN CURRENT_TIMESTAMP ELSE finished_at END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(status, status, sessionId).run();
  return jsonResponse(request, { status });
}

function normalizedText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, " ").trim();
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20,
};

async function inventoryCandidates(database: D1Database): Promise<Array<{ id: number; name: string; normalized: string; base_unit: string }>> {
  const items = await database.prepare(
    `SELECT id, name, base_unit FROM inventory_items WHERE active = 1 ORDER BY LENGTH(name) DESC`,
  ).all<{ id: number; name: string; base_unit: string }>();
  return items.results.map((item) => ({ ...item, normalized: normalizedText(item.name) }));
}

function parseSegment(
  segment: string,
  candidates: Array<{ id: number; name: string; normalized: string; base_unit: string }>,
) {
  const normalized = normalizedText(segment);
  const item = candidates.find((candidate) => normalized.includes(candidate.normalized));
  const numeric = /(?:^|\s)(\d+(?:\.\d+)?)(?:\s|$)/u.exec(normalized);
  const wordEntry = Object.entries(NUMBER_WORDS).find(([word]) => new RegExp(`(?:^|\\s)${word}(?:\\s|$)`, "u").test(normalized));
  const quantity = numeric ? Number(numeric[1]) : wordEntry?.[1] ?? null;
  const action = /\badd\b/u.test(normalized) ? "ADD"
    : /\b(?:change|replace)\b/u.test(normalized) ? "REPLACE"
      : /\b(?:remove|delete)\b/u.test(normalized) ? "REMOVE" : "SET";
  const unitMatch = quantity === null ? null : /(?:\d+(?:\.\d+)?|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s+([a-z]+)/u.exec(normalized);
  return { item, quantity, action, spokenUnit: unitMatch?.[1] ?? item?.base_unit ?? null };
}

function responseText(payload:JsonObject):string|null{if(typeof payload.output_text==="string")return payload.output_text;const output=Array.isArray(payload.output)?payload.output:[];for(const item of output)if(isObject(item)&&Array.isArray(item.content))for(const content of item.content)if(isObject(content)&&typeof content.text==="string")return content.text;return null}
async function resolveWithOpenAI(segments:string[],candidates:Array<{id:number;name:string;normalized:string;base_unit:string}>,bindings:RuntimeBindings){
  if(!bindings.openaiApiKey||segments.length===0)return null;const allowed=new Map(candidates.map(item=>[item.id,item]));const response=await fetch("https://api.openai.com/v1/responses",{method:"POST",headers:{Authorization:`Bearer ${bindings.openaiApiKey}`,"Content-Type":"application/json"},body:JSON.stringify({model:bindings.openaiNormalizationModel,input:[{role:"system",content:"Normalize restaurant inventory speech. Treat next and bump as item separators. Never invent an item ID; use only the supplied catalog. Return null item_id when uncertain. Quantities must be nonnegative numbers. Actions are SET, ADD, REPLACE, or REMOVE."},{role:"user",content:JSON.stringify({segments,catalog:candidates.map(({id,name,base_unit})=>({id,name,base_unit}))})}],text:{format:{type:"json_schema",name:"voice_inventory_normalization",strict:true,schema:{type:"object",additionalProperties:false,properties:{entries:{type:"array",items:{type:"object",additionalProperties:false,properties:{index:{type:"integer"},item_id:{type:["integer","null"]},quantity:{type:["number","null"]},unit:{type:["string","null"]},action:{type:"string",enum:["SET","ADD","REPLACE","REMOVE"]}},required:["index","item_id","quantity","unit","action"]}}},required:["entries"]}}}})});if(!response.ok){console.error(JSON.stringify({message:"OpenAI inventory normalization failed",status:response.status}));return null}const payload=await response.json<JsonObject>(),text=responseText(payload);if(!text)return null;try{const parsed=JSON.parse(text) as {entries:Array<{index:number;item_id:number|null;quantity:number|null;unit:string|null;action:string}>};return parsed.entries.map(entry=>({...entry,item:entry.item_id===null?undefined:allowed.get(entry.item_id)})).filter(entry=>Number.isInteger(entry.index)&&entry.index>=0&&entry.index<segments.length)}catch{return null}}

async function serializeUtterance(database: D1Database, utteranceId: number): Promise<JsonObject | null> {
  const utterance = await database.prepare(
    `SELECT id, client_event_id, sequence, transcript, status, normalized_payload, created_at
     FROM inventory_voice_utterances WHERE id = ?`,
  ).bind(utteranceId).first<Record<string, unknown>>();
  if (utterance === null) return null;
  const entries = await database.prepare(
    `SELECT e.id, e.utterance_id, e.location_id, l.name AS location_name,
      e.inventory_item_id, i.name AS item_name, e.action, e.spoken_item,
      e.spoken_quantity, e.spoken_unit, e.normalized_quantity, i.base_unit,
      e.evidence, e.ambiguity_reason, e.review_status, e.supersedes_entry_id,
      e.created_at FROM inventory_voice_entries e
      JOIN inventory_locations l ON l.id = e.location_id
      LEFT JOIN inventory_items i ON i.id = e.inventory_item_id
      WHERE e.utterance_id = ? ORDER BY e.id`,
  ).bind(utteranceId).all<Record<string, unknown>>();
  const parsed = typeof utterance.normalized_payload === "string"
    ? JSON.parse(utterance.normalized_payload) : utterance.normalized_payload;
  const rows: JsonObject[] = entries.results.map((row) => ({ ...row, created_at: iso(row.created_at) }));
  const needsReview = rows.some((row) => row.review_status === "NEEDS_REVIEW");
  const command = isObject(parsed) ? parsed.command : null;
  const switchedLocation = isObject(parsed) && typeof parsed.location_name === "string" ? parsed.location_name : null;
  return {
    ...utterance,
    normalized_payload: parsed,
    created_at: iso(utterance.created_at),
    entries: rows,
    feedback: {
      tone: needsReview ? "warning" : "success",
      speak: command === "SWITCH_LOCATION" && switchedLocation ? `Switched to ${switchedLocation}.`
        : needsReview ? "I could not confidently match one of those counts. Please review it."
        : `${rows.length} inventory ${rows.length === 1 ? "item" : "items"} saved.`,
      clarification_needed: needsReview,
      options: [],
    },
  };
}

async function utterance(request: Request, sessionId: number, bindings: RuntimeBindings): Promise<Response> {
  const owned = await ownedSession(request, bindings, sessionId);
  if (owned.response !== null || owned.session === null) return owned.response ?? apiError(request, 404, "Voice inventory session not found");
  const input = await body(request);
  if (input instanceof Response) return input;
  const clientEventId = typeof input.client_event_id === "string" ? input.client_event_id : "";
  const sequence = numberValue(input.sequence);
  const transcript = typeof input.transcript === "string" ? input.transcript.trim() : "";
  if (clientEventId.length < 8 || !Number.isInteger(sequence) || sequence < 1 || !transcript) {
    return apiError(request, 422, "client_event_id, sequence, and transcript are required");
  }
  const existing = await bindings.database.prepare(
    "SELECT id FROM inventory_voice_utterances WHERE session_id = ? AND client_event_id = ?",
  ).bind(sessionId, clientEventId).first<{ id: number }>();
  if (existing !== null) return jsonResponse(request, await serializeUtterance(bindings.database, existing.id), { status: 201 });

  const normalized = normalizedText(transcript);
  let command: string | null = /^pause\b/u.test(normalized) ? "PAUSE" : /^resume\b/u.test(normalized) ? "RESUME"
    : /^(?:finish|done|complete)\b/u.test(normalized) ? "FINISH" : null;
  let switchedLocation: { id: number; name: string } | null = null;
  const switchMatch = /^(?:switch|move|go|location|now)(?:\s+(?:to|in|at))?\s+(.+)$/u.exec(normalized);
  if (command === null && switchMatch !== null) {
    const locationPhrase = normalizedText(switchMatch[1]);
    const locations = await bindings.database.prepare(
      "SELECT id, name FROM inventory_locations WHERE active=1 ORDER BY name",
    ).all<{ id: number; name: string }>();
    const matches = locations.results.filter((location) => {
      const candidate = normalizedText(location.name);
      return candidate === locationPhrase || candidate.includes(locationPhrase) || locationPhrase.includes(candidate);
    });
    if (matches.length === 1) {
      command = "SWITCH_LOCATION";
      switchedLocation = matches[0];
    }
  }
  const segments = command ? [] : transcript.split(/\b(?:next|bump)\b/iu).map((part) => part.trim()).filter(Boolean);
  const candidates = await inventoryCandidates(bindings.database);
  const parsed = segments.map((segment) => ({ segment, ...parseSegment(segment, candidates) }));
  if(parsed.some(entry=>entry.item===undefined||entry.quantity===null)){
    const resolved=await resolveWithOpenAI(segments,candidates,bindings);for(const entry of resolved??[]){const target=parsed[entry.index];if(!target)continue;if(entry.item)target.item=entry.item;if(entry.quantity!==null)target.quantity=entry.quantity;if(entry.unit)target.spokenUnit=entry.unit;if(["SET","ADD","REPLACE","REMOVE"].includes(entry.action))target.action=entry.action}
  }
  const needsReview = parsed.some((entry) => entry.item === undefined || entry.quantity === null);
  const utteranceId = randomId();
  const status = command ? "ACCEPTED" : needsReview ? "NEEDS_CLARIFICATION" : "ACCEPTED";
  const normalizedPayload = JSON.stringify({
    command,
    location_id: switchedLocation?.id ?? null,
    location_name: switchedLocation?.name ?? null,
    entries: parsed.map((entry) => ({ item_id: entry.item?.id ?? null, quantity: entry.quantity,
      action: entry.action, unit: entry.spokenUnit })),
  });
  const statements: D1PreparedStatement[] = [bindings.database.prepare(
    `INSERT INTO inventory_voice_utterances
     (id, session_id, client_event_id, sequence, realtime_item_id, started_at,
      ended_at, transcript, normalized_payload, status, audio_object_key,
      audio_missing, error_details, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
  ).bind(utteranceId, sessionId, clientEventId, sequence,
    typeof input.realtime_item_id === "string" ? input.realtime_item_id : null,
    typeof input.started_at === "string" ? input.started_at : null,
    typeof input.ended_at === "string" ? input.ended_at : null,
    transcript, normalizedPayload, status,
    typeof input.audio_object_key === "string" ? input.audio_object_key : null)];
  for (const entry of parsed) {
    statements.push(bindings.database.prepare(
      `INSERT INTO inventory_voice_entries
       (id, session_id, utterance_id, location_id, inventory_item_id, action,
        spoken_item, spoken_quantity, spoken_unit, normalized_quantity,
        evidence, ambiguity_reason, review_status, supersedes_entry_id,
        created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(randomId(), sessionId, utteranceId, owned.session.current_location_id,
      entry.item?.id ?? null, entry.action, entry.segment, entry.quantity,
      entry.spokenUnit, entry.quantity, entry.segment,
      entry.item === undefined ? "Inventory item could not be matched" : entry.quantity === null ? "Quantity could not be determined" : null,
      entry.item !== undefined && entry.quantity !== null ? "AUTO_ACCEPTED" : "NEEDS_REVIEW"));
  }
  const nextStatus = command === "PAUSE" ? "PAUSED" : command === "RESUME" ? "LISTENING"
    : command === "FINISH" ? "NEEDS_REVIEW" : needsReview ? "NEEDS_REVIEW" : "LISTENING";
  statements.push(bindings.database.prepare(
    `UPDATE inventory_voice_sessions SET last_client_sequence = ?, status = ?,
      current_location_id = COALESCE(?, current_location_id),
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(Math.max(sequence, owned.session.last_client_sequence), nextStatus, switchedLocation?.id ?? null, sessionId));
  try {
    await bindings.database.batch(statements);
  } catch (error) {
    if (error instanceof Error && /unique|constraint/iu.test(error.message)) {
      const duplicate = await bindings.database.prepare(
        "SELECT id FROM inventory_voice_utterances WHERE session_id = ? AND (client_event_id = ? OR sequence = ?)",
      ).bind(sessionId, clientEventId, sequence).first<{ id: number }>();
      if (duplicate !== null) return jsonResponse(request, await serializeUtterance(bindings.database, duplicate.id), { status: 201 });
    }
    throw error;
  }
  return jsonResponse(request, await serializeUtterance(bindings.database, utteranceId), { status: 201 });
}

async function patchEntry(request: Request, sessionId: number, entryId: number, bindings: RuntimeBindings): Promise<Response> {
  const owned = await ownedSession(request, bindings, sessionId);
  if (owned.response !== null || owned.session === null) return owned.response ?? apiError(request, 404, "Voice inventory session not found");
  const input = await body(request);
  if (input instanceof Response) return input;
  const existing = await bindings.database.prepare(
    `SELECT id, utterance_id, location_id, inventory_item_id, action, spoken_item,
      spoken_quantity, spoken_unit, normalized_quantity, evidence, review_status
     FROM inventory_voice_entries WHERE id = ? AND session_id = ?`,
  ).bind(entryId, sessionId).first<Record<string, unknown>>();
  if (existing === null) return apiError(request, 404, "Voice inventory entry not found");
  const locked = await bindings.database.prepare(
    `SELECT 1 FROM inventory_voice_session_counts sc
     JOIN inventory_counts c ON c.id = sc.inventory_count_id
     WHERE sc.session_id = ? AND c.status != 'DRAFT' LIMIT 1`,
  ).bind(sessionId).first();
  if (locked !== null) return apiError(request, 409, "Voice entries cannot change after a linked count is submitted");
  const requestedStatus = typeof input.review_status === "string" ? input.review_status : null;
  if (requestedStatus === "REJECTED") {
    await bindings.database.prepare(
      `UPDATE inventory_voice_entries SET review_status='REJECTED', ambiguity_reason=NULL,
       updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(entryId).run();
    if (owned.session.finished_at !== null) await finish(request, sessionId, bindings);
    const rejected = (await sessionEntries(bindings.database, sessionId)).find((entry) => numberValue(entry.id) === entryId);
    return jsonResponse(request, rejected);
  }
  const itemId = input.inventory_item_id === undefined ? numberValue(existing.inventory_item_id) : numberValue(input.inventory_item_id);
  const locationId = input.location_id === undefined ? numberValue(existing.location_id) : numberValue(input.location_id);
  const quantity = input.quantity === undefined ? numberValue(existing.spoken_quantity, numberValue(existing.normalized_quantity)) : numberValue(input.quantity);
  const [item, location] = await bindings.database.batch([
    bindings.database.prepare("SELECT id, base_unit FROM inventory_items WHERE id=? AND active=1").bind(itemId),
    bindings.database.prepare("SELECT id FROM inventory_locations WHERE id=? AND active=1").bind(locationId),
  ]);
  if (item.results.length === 0 || location.results.length === 0) return apiError(request, 404, "Inventory item or location not found");
  if (quantity < 0) return apiError(request, 400, "Quantity must be nonnegative");
  const priorEffective = effectiveCounts((await sessionEntries(bindings.database, sessionId))
    .filter((entry) => numberValue(entry.id) !== entryId));
  const action = priorEffective.some((entry) => numberValue(entry.location_id) === locationId
    && numberValue(entry.inventory_item_id) === itemId) ? "REPLACE" : "SET";
  const replacementId = randomId();
  await bindings.database.batch([
    bindings.database.prepare(
      "UPDATE inventory_voice_entries SET review_status='REJECTED', ambiguity_reason=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?",
    ).bind(entryId),
    bindings.database.prepare(
      `INSERT INTO inventory_voice_entries
       (id, session_id, utterance_id, location_id, inventory_item_id, action,
        spoken_item, spoken_quantity, spoken_unit, normalized_quantity, evidence,
        ambiguity_reason, review_status, supersedes_entry_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'CORRECTED', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(replacementId, sessionId, numberValue(existing.utterance_id), locationId, itemId,
      action, existing.spoken_item, quantity,
      typeof input.unit === "string" ? input.unit : existing.spoken_unit,
      quantity, existing.evidence, entryId),
    bindings.database.prepare(
      `UPDATE inventory_voice_utterances SET status = CASE WHEN EXISTS(
        SELECT 1 FROM inventory_voice_entries WHERE utterance_id=? AND id != ? AND review_status='NEEDS_REVIEW'
       ) THEN status ELSE 'ACCEPTED' END, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
    ).bind(numberValue(existing.utterance_id), entryId, numberValue(existing.utterance_id)),
  ]);
  if (owned.session.finished_at !== null) await finish(request, sessionId, bindings);
  const row = (await sessionEntries(bindings.database, sessionId)).find((entry) => numberValue(entry.id) === replacementId);
  return jsonResponse(request, row);
}

async function clarification(request: Request, sessionId: number, bindings: RuntimeBindings): Promise<Response> {
  const owned = await ownedSession(request, bindings, sessionId);
  if (owned.response !== null || owned.session === null) return owned.response ?? apiError(request, 404, "Voice inventory session not found");
  const input = await body(request);
  if (input instanceof Response) return input;
  const utteranceId = numberValue(input.utterance_id);
  const unresolved = await bindings.database.prepare(
    `SELECT e.id FROM inventory_voice_entries e
     JOIN inventory_voice_utterances u ON u.id=e.utterance_id
     WHERE e.session_id=? AND e.utterance_id=? AND e.review_status='NEEDS_REVIEW'
     ORDER BY e.id LIMIT 1`,
  ).bind(sessionId, utteranceId).first<{ id: number }>();
  if (unresolved === null) {
    const utteranceExists = await bindings.database.prepare(
      "SELECT id FROM inventory_voice_utterances WHERE id=? AND session_id=?",
    ).bind(utteranceId, sessionId).first();
    return utteranceExists === null
      ? apiError(request, 404, "Voice utterance not found")
      : apiError(request, 409, "This utterance is already resolved");
  }
  const patchRequest = new Request(request.url, {
    method: "PATCH",
    headers: request.headers,
    body: JSON.stringify({
      inventory_item_id: input.selected_inventory_item_id,
      location_id: input.selected_location_id,
      quantity: input.quantity,
      unit: input.unit,
      review_status: input.reject === true ? "REJECTED" : undefined,
    }),
  });
  return patchEntry(patchRequest, sessionId, unresolved.id, bindings);
}

async function finish(request: Request, sessionId: number, bindings: RuntimeBindings): Promise<Response> {
  const owned = await ownedSession(request, bindings, sessionId);
  if (owned.response !== null || owned.session === null || owned.auth.user === null) return owned.response ?? apiError(request, 404, "Voice inventory session not found");
  const serialized = await serializeSession(bindings.database, owned.session);
  const effective = serialized.effective_counts as JsonObject[];
  const grouped = new Map<number, JsonObject[]>();
  for (const row of effective) {
    const locationId = numberValue(row.location_id);
    grouped.set(locationId, [...(grouped.get(locationId) ?? []), row]);
  }
  for (const [locationId, rows] of grouped) {
    const linked = await bindings.database.prepare(
      "SELECT inventory_count_id FROM inventory_voice_session_counts WHERE session_id = ? AND location_id = ?",
    ).bind(sessionId, locationId).first<{ inventory_count_id: number }>();
    const countId = linked?.inventory_count_id ?? randomId();
    const statements: D1PreparedStatement[] = [];
    if (linked === null) statements.push(bindings.database.prepare(
      `INSERT INTO inventory_counts
       (id, location_id, template_id, status, counted_by_user_id, reviewed_by_user_id,
        notes, revision, approved_at, created_at, updated_at)
       VALUES (?, ?, NULL, 'DRAFT', ?, NULL, ?, 1, NULL, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(countId, locationId, owned.auth.user.id, `Created by voice inventory session #${sessionId}`));
    rows.forEach((row, index) => statements.push(bindings.database.prepare(
      `INSERT INTO inventory_count_lines
       (id, count_id, inventory_item_id, counted_quantity, expected_quantity,
        notes, display_order, is_counted, source, confidence, review_status,
        evidence, revision, updated_by_user_id)
       VALUES (?, ?, ?, ?, (SELECT quantity_on_hand FROM inventory_balances
        WHERE inventory_item_id = ? AND location_id = ?), NULL, ?, 1, 'VOICE',
        1, 'READY', ?, 1, ?)
       ON CONFLICT(count_id, inventory_item_id) DO UPDATE SET
        counted_quantity = excluded.counted_quantity, is_counted = 1,
        source = 'VOICE', confidence = 1, review_status = 'READY',
        evidence = excluded.evidence,
        revision = inventory_count_lines.revision + 1,
        updated_by_user_id = excluded.updated_by_user_id`,
    ).bind(randomId(), countId, numberValue(row.inventory_item_id), numberValue(row.quantity),
      numberValue(row.inventory_item_id), locationId, index,
      `Voice session #${sessionId}`, owned.auth.user?.id)));
    if (linked === null) statements.push(bindings.database.prepare(
      `INSERT INTO inventory_voice_session_counts
       (id, session_id, location_id, inventory_count_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    ).bind(randomId(), sessionId, locationId, countId));
    statements.push(bindings.database.prepare(
      "UPDATE inventory_counts SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    ).bind(countId));
    await bindings.database.batch(statements);
  }
  const blocking = numberValue(serialized.blocking_review_count);
  const status = blocking ? "NEEDS_REVIEW" : "FINISHED";
  await bindings.database.prepare(
    `UPDATE inventory_voice_sessions SET status = ?, finished_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
  ).bind(status, sessionId).run();
  const row = await readSessionRow(bindings.database, sessionId);
  if (row === null) throw new Error("Finished session disappeared");
  return jsonResponse(request, await serializeSession(bindings.database, row));
}

async function csvExport(request: Request, sessionId: number, bindings: RuntimeBindings): Promise<Response> {
  const owned = await ownedSession(request, bindings, sessionId);
  if (owned.response !== null || owned.session === null) return owned.response ?? apiError(request, 404, "Voice inventory session not found");
  const session = await serializeSession(bindings.database, owned.session);
  const rows = session.entries as JsonObject[];
  const escape = (value: unknown) => {const text=String(value??"");return /[",\r\n]/u.test(text)?`"${text.replaceAll('"','""')}"`:text};
  const headers=["timestamp","location","transcript","evidence","action","spoken_item","matched_item","spoken_quantity","spoken_unit","base_quantity","base_unit","review_status","issue","source_entry"];
  const csv="\uFEFF"+[headers,...rows.map(row=>[row.created_at,row.location_name,row.transcript,row.evidence,row.action,row.spoken_item,row.item_name,row.spoken_quantity,row.spoken_unit,row.normalized_quantity,row.base_unit,row.review_status,row.ambiguity_reason,row.supersedes_entry_id])].map(values=>values.map(escape).join(",")).join("\r\n")+"\r\n";
  return new Response(csv, { headers: {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="voice-inventory-${sessionId}.csv"`,
    "Cache-Control": "no-store",
  } });
}

async function xlsxExport(request:Request,sessionId:number,bindings:RuntimeBindings):Promise<Response>{const owned=await ownedSession(request,bindings,sessionId);if(owned.response!==null||owned.session===null)return owned.response??apiError(request,404,"Voice inventory session not found");const session=await serializeSession(bindings.database,owned.session),counts=session.effective_counts as JsonObject[],audit=session.entries as JsonObject[];const summaryHeaders=["Location","Inventory Item","Quantity","Base Unit","Source Entry IDs"],auditHeaders=["Timestamp","Location","Transcript","Evidence","Action","Spoken Item","Matched Item","Spoken Qty","Spoken Unit","Base Qty","Base Unit","Review Status","Issue","Supersedes"],reviewHeaders=["Timestamp","Location","Evidence","Spoken Item","Matched Item","Quantity","Unit","Status","Issue"];const review=audit.filter(row=>["NEEDS_REVIEW","CORRECTED","REJECTED"].includes(String(row.review_status)));const bytes=createXlsx([
  {name:"Count Summary",title:"Voice Inventory Count Summary",meta:[`Session #${sessionId}`,`Manager: ${owned.session.manager_full_name}`,`Started: ${String(session.started_at).slice(0,16)}`,`Status: ${session.status}`,""],headers:summaryHeaders,rows:counts.map(row=>[row.location_name,row.item_name,numberValue(row.quantity),row.base_unit,(row.source_entry_ids as number[]).join(", ")]),widths:[24,34,14,14,24],freeze:"A4",numberColumns:[3]},
  {name:"Voice Audit",title:"Voice Inventory Audit",meta:["Every voice-derived action and correction is preserved."],headers:auditHeaders,rows:audit.map(row=>[row.created_at,row.location_name,row.transcript,row.evidence,row.action,row.spoken_item,row.item_name,row.spoken_quantity,row.spoken_unit,row.normalized_quantity,row.base_unit,row.review_status,row.ambiguity_reason,row.supersedes_entry_id]),widths:[20,22,42,34,13,25,28,13,14,13,13,18,36,12],freeze:"A4",numberColumns:[8,10]},
  {name:"Needs Review",title:"Voice Inventory Review Queue",meta:["Entries requiring attention or changed during review."],headers:reviewHeaders,rows:review.map(row=>[row.created_at,row.location_name,row.evidence,row.spoken_item,row.item_name,row.normalized_quantity,row.base_unit??row.spoken_unit,row.review_status,row.ambiguity_reason]),widths:[20,22,36,25,28,14,14,18,40],freeze:"A4",numberColumns:[6]},
  ]);return new Response(bytes,{headers:{"Content-Type":XLSX_CONTENT_TYPE,"Content-Disposition":`attachment; filename="voice-inventory-${sessionId}.xlsx"`,"Cache-Control":"no-store"}})}

async function printExport(request: Request, sessionId: number, bindings: RuntimeBindings): Promise<Response> {
  const owned = await ownedSession(request, bindings, sessionId);
  if (owned.response !== null || owned.session === null) return owned.response ?? apiError(request, 404, "Voice inventory session not found");
  const session = await serializeSession(bindings.database, owned.session);
  const rows = session.effective_counts as JsonObject[];
  const safe = (value: unknown) => String(value ?? "").replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Voice Inventory ${sessionId}</title><style>body{font:14px Arial;margin:32px}table{border-collapse:collapse;width:100%}th,td{border:1px solid #999;padding:8px;text-align:left}@media print{button{display:none}}</style></head><body><button onclick="print()">Print</button><h1>Voice Inventory</h1><p>Session #${sessionId}</p><table><thead><tr><th>Location</th><th>Item</th><th>Quantity</th><th>Unit</th></tr></thead><tbody>${rows.map((row) => `<tr><td>${safe(row.location_name)}</td><td>${safe(row.item_name)}</td><td>${safe(row.quantity)}</td><td>${safe(row.base_unit)}</td></tr>`).join("")}</tbody></table></body></html>`;
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
}

async function realtimeToken(request:Request,sessionId:number,bindings:RuntimeBindings):Promise<Response>{
  const owned=await ownedSession(request,bindings,sessionId);if(owned.response!==null)return owned.response;if(!bindings.openaiApiKey)return jsonResponse(request,{detail:{code:"OPENAI_NOT_CONFIGURED",message:"Realtime transcription is unavailable; use browser fallback."}},{status:503});
  const response=await fetch("https://api.openai.com/v1/realtime/client_secrets",{method:"POST",headers:{Authorization:`Bearer ${bindings.openaiApiKey}`,"Content-Type":"application/json"},body:JSON.stringify({session:{type:"transcription",audio:{input:{transcription:{model:"gpt-4o-transcribe",language:"en",prompt:"Restaurant inventory count. Items may include food, liquor, beer, wine, kitchen supplies, and transition words next or bump."},noise_reduction:{type:"near_field"},turn_detection:{type:"server_vad",silence_duration_ms:650,prefix_padding_ms:300}}}}})});
  if(!response.ok){console.error(JSON.stringify({message:"OpenAI realtime token request failed",status:response.status,session_id:sessionId}));return jsonResponse(request,{detail:{code:"OPENAI_REALTIME_FAILED",message:"Realtime transcription is temporarily unavailable; use browser fallback."}},{status:503})}const token=await response.json<JsonObject>();return jsonResponse(request,{value:token.value,expires_at:token.expires_at});
}

export async function routeVoiceInventory(
  request: Request,
  url: URL,
  bindings: RuntimeBindings,
): Promise<Response | null> {
  if (url.pathname === "/inventory/voice/sessions/active") {
    return request.method === "GET" ? active(request, bindings) : methodNotAllowed(request, "GET");
  }
  if (url.pathname === "/inventory/voice/sessions") {
    return request.method === "POST" ? createSession(request, bindings) : methodNotAllowed(request, "POST");
  }
  const utteranceMatch = /^\/inventory\/voice\/sessions\/(\d+)\/utterances$/u.exec(url.pathname);
  if (utteranceMatch !== null) return request.method === "POST" ? utterance(request, Number(utteranceMatch[1]), bindings) : methodNotAllowed(request, "POST");
  const entryMatch = /^\/inventory\/voice\/sessions\/(\d+)\/entries\/(\d+)$/u.exec(url.pathname);
  if (entryMatch !== null) return request.method === "PATCH" ? patchEntry(request, Number(entryMatch[1]), Number(entryMatch[2]), bindings) : methodNotAllowed(request, "PATCH");
  const clarificationMatch = /^\/inventory\/voice\/sessions\/(\d+)\/clarifications$/u.exec(url.pathname);
  if (clarificationMatch !== null) return request.method === "POST" ? clarification(request, Number(clarificationMatch[1]), bindings) : methodNotAllowed(request, "POST");
  const stateMatch = /^\/inventory\/voice\/sessions\/(\d+)\/(pause|resume|offline|abandon)$/u.exec(url.pathname);
  if (stateMatch !== null) {
    const status = ({ pause: "PAUSED", resume: "LISTENING", offline: "OFFLINE", abandon: "ABANDONED" } as const)[stateMatch[2] as "pause" | "resume" | "offline" | "abandon"];
    return request.method === "POST" ? stateChange(request, Number(stateMatch[1]), status, bindings) : methodNotAllowed(request, "POST");
  }
  const finishMatch = /^\/inventory\/voice\/sessions\/(\d+)\/finish$/u.exec(url.pathname);
  if (finishMatch !== null) return request.method === "POST" ? finish(request, Number(finishMatch[1]), bindings) : methodNotAllowed(request, "POST");
  const realtimeMatch = /^\/inventory\/voice\/sessions\/(\d+)\/realtime-token$/u.exec(url.pathname);
  if (realtimeMatch !== null) {
    return request.method === "POST" ? realtimeToken(request,Number(realtimeMatch[1]),bindings) : methodNotAllowed(request, "POST");
  }
  const csvMatch = /^\/inventory\/voice\/sessions\/(\d+)\/export\.csv$/u.exec(url.pathname);
  if (csvMatch !== null) return request.method === "GET" ? csvExport(request, Number(csvMatch[1]), bindings) : methodNotAllowed(request, "GET");
  const xlsxMatch = /^\/inventory\/voice\/sessions\/(\d+)\/export\.xlsx$/u.exec(url.pathname);
  if (xlsxMatch !== null) return request.method === "GET" ? xlsxExport(request, Number(xlsxMatch[1]), bindings) : methodNotAllowed(request, "GET");
  const printMatch = /^\/inventory\/voice\/sessions\/(\d+)\/print$/u.exec(url.pathname);
  if (printMatch !== null) return request.method === "GET" ? printExport(request, Number(printMatch[1]), bindings) : methodNotAllowed(request, "GET");
  const sessionMatch = /^\/inventory\/voice\/sessions\/(\d+)$/u.exec(url.pathname);
  if (sessionMatch !== null) return request.method === "GET" ? readSession(request, Number(sessionMatch[1]), bindings) : methodNotAllowed(request, "GET");
  return null;
}
