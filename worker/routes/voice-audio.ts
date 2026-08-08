import { apiError, jsonResponse, validationError } from "../http";
import { VoiceAudioRepository } from "../repositories/voice-audio";
import type { VoiceRuntimeBindings } from "../runtime";
import { authenticateRequest, requireManagerOrAdmin } from "./auth";

const UPLOAD_TTL_SECONDS = 15 * 60;
const AUDIO_CONTENT_TYPES: Record<string, string> = {
  "audio/webm": "webm",
  "audio/mp4": "m4a",
  "audio/ogg": "ogg",
  "audio/wav": "wav",
};

function isoWithoutZulu(date: Date): string {
  return date.toISOString().replace(/Z$/u, "");
}

function safeExtension(filename: string, contentType: string): string {
  const match = /\.([a-z0-9]{1,8})$/iu.exec(filename);
  return match?.[1]?.toLowerCase() ?? AUDIO_CONTENT_TYPES[contentType] ?? "bin";
}

function base64Url(bytes: ArrayBuffer): string {
  const values = new Uint8Array(bytes);
  let binary = "";
  for (const value of values) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function uploadSignature(
  objectKey: string,
  expires: number,
  secretKey: string,
): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    await crypto.subtle.sign("HMAC", key, encoder.encode(`${objectKey}:${expires}`)),
  );
}

async function validSignature(
  provided: string,
  objectKey: string,
  expires: number,
  secretKey: string,
): Promise<boolean> {
  if (!Number.isSafeInteger(expires) || expires < Math.floor(Date.now() / 1000)) return false;
  const expected = await uploadSignature(objectKey, expires, secretKey);
  const encoder = new TextEncoder();
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function requestBody(input: unknown): { contentType: string; filename: string } | null {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const contentType = record.content_type ?? "audio/webm";
  const filename = record.filename ?? "chunk.webm";
  if (
    typeof contentType !== "string" || contentType.length > 100 ||
    typeof filename !== "string" || filename.length > 150
  ) return null;
  return { contentType, filename };
}

async function authorizedSession(
  request: Request,
  sessionId: number,
  bindings: VoiceRuntimeBindings,
): Promise<{ response: Response | null }> {
  const authentication = await authenticateRequest(request, bindings);
  if (authentication.response !== null) return { response: authentication.response };
  if (authentication.user === null) {
    return { response: apiError(request, 401, "Could not validate credentials") };
  }
  const roleError = requireManagerOrAdmin(request, authentication.user.role);
  if (roleError !== null) return { response: roleError };
  const access = await new VoiceAudioRepository(bindings.database).sessionForUser(
    sessionId,
    authentication.user,
  );
  if (access.session === null) {
    return { response: apiError(request, 404, "Voice inventory session not found") };
  }
  if (access.forbidden) {
    return {
      response: apiError(request, 403, "This voice session belongs to another manager"),
    };
  }
  return { response: null };
}

export async function createVoiceAudioUploadTarget(
  request: Request,
  sessionId: number,
  bindings: VoiceRuntimeBindings,
): Promise<Response> {
  const authorization = await authorizedSession(request, sessionId, bindings);
  if (authorization.response !== null) return authorization.response;
  let input: unknown;
  try {
    input = await request.json();
  } catch {
    return validationError(request, [{
      type: "json_invalid", loc: ["body", 0], msg: "JSON decode error", input: {},
      ctx: { error: "Invalid JSON" },
    }]);
  }
  const body = requestBody(input);
  if (body === null) {
    return validationError(request, [{
      type: "string_type", loc: ["body"], msg: "Invalid audio upload request", input,
    }]);
  }
  const uploadId = crypto.randomUUID();
  const extension = safeExtension(body.filename, body.contentType);
  const objectKey = `voice/${bindings.environment}/sessions/${sessionId}/${uploadId}.${extension}`;
  const expires = Math.floor(Date.now() / 1000) + UPLOAD_TTL_SECONDS;
  const now = isoWithoutZulu(new Date());
  const expiresAt = isoWithoutZulu(new Date(expires * 1000));
  await new VoiceAudioRepository(bindings.database).createPending({
    sessionId,
    uploadId,
    objectKey,
    contentType: body.contentType,
    originalFilename: body.filename,
    uploadExpiresAt: expiresAt,
    now,
  });
  const signature = await uploadSignature(objectKey, expires, bindings.secretKey);
  return jsonResponse(request, {
    object_key: objectKey,
    upload_url:
      `/inventory/voice/sessions/${sessionId}/audio/${uploadId}` +
      `?extension=${extension}&expires=${expires}&signature=${encodeURIComponent(signature)}`,
    method: "PUT",
    expires_at: `${expiresAt}Z`,
    headers: { "Content-Type": body.contentType },
  });
}

async function readBoundedBody(
  body: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      received += result.value.byteLength;
      if (received > maximumBytes) throw new Error("AUDIO_TOO_LARGE");
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const combined = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined;
}

export async function uploadVoiceAudio(
  request: Request,
  sessionId: number,
  uploadId: string,
  bindings: VoiceRuntimeBindings,
): Promise<Response> {
  const url = new URL(request.url);
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  const extension = url.searchParams.get("extension") ?? "";
  if (!/^[a-z0-9]{1,8}$/u.test(extension)) {
    return validationError(request, [{
      type: "string_pattern_mismatch", loc: ["query", "extension"],
      msg: "String should match pattern '^[a-z0-9]{1,8}$'", input: extension,
    }]);
  }
  const repository = new VoiceAudioRepository(bindings.database);
  const record = await repository.findByUpload(sessionId, uploadId);
  if (
    record === null || record.status !== "PENDING" ||
    !record.object_key.endsWith(`.${extension}`) ||
    !(await validSignature(signature, record.object_key, expires, bindings.secretKey))
  ) {
    return apiError(request, 403, "Audio upload target expired or invalid");
  }
  const contentLength = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(contentLength) && contentLength > bindings.maxAudioChunkBytes) {
    return apiError(request, 413, "Audio chunk exceeds the 8 MB limit");
  }
  if (request.body === null) return apiError(request, 400, "Audio upload body is required");
  let stored: R2Object;
  try {
    const audio = await readBoundedBody(request.body, bindings.maxAudioChunkBytes);
    stored = await bindings.voiceAudio.put(
      record.object_key,
      audio,
      {
        httpMetadata: { contentType: record.content_type },
        customMetadata: { sessionId: String(sessionId), uploadId },
      },
    );
  } catch (error) {
    await bindings.voiceAudio.delete(record.object_key);
    if (error instanceof Error && error.message === "AUDIO_TOO_LARGE") {
      return apiError(request, 413, "Audio chunk exceeds the 8 MB limit");
    }
    throw error;
  }
  try {
    await repository.markStored(record.id, stored.size, stored.httpEtag, isoWithoutZulu(new Date()));
  } catch (error) {
    await bindings.voiceAudio.delete(record.object_key);
    throw error;
  }
  return new Response(null, { status: 204 });
}

function safeDownloadFilename(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]+/gu, "-").replace(/^-+|-+$/gu, "") || "voice-audio";
}

export async function downloadVoiceAudio(
  request: Request,
  sessionId: number,
  uploadId: string,
  bindings: VoiceRuntimeBindings,
): Promise<Response> {
  const authorization = await authorizedSession(request, sessionId, bindings);
  if (authorization.response !== null) return authorization.response;
  const repository = new VoiceAudioRepository(bindings.database);
  const record = await repository.findByUpload(sessionId, uploadId);
  if (record === null || record.status !== "STORED") {
    return apiError(request, 404, "Voice audio object not found");
  }
  const object = await bindings.voiceAudio.get(record.object_key);
  if (object === null) {
    await repository.markMissing(record, isoWithoutZulu(new Date()));
    return apiError(request, 404, "Voice audio object not found");
  }
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": `inline; filename="${safeDownloadFilename(record.original_filename)}"`,
    "Content-Length": String(object.size),
    "Content-Type": record.content_type,
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(request.method === "HEAD" ? null : object.body, { headers });
}

async function deleteKeys(bucket: R2Bucket, keys: string[]): Promise<void> {
  for (let offset = 0; offset < keys.length; offset += 1000) {
    await bucket.delete(keys.slice(offset, offset + 1000));
  }
}

export async function cleanupExpiredVoiceAudio(
  bindings: VoiceRuntimeBindings,
  now = new Date(),
): Promise<number> {
  const repository = new VoiceAudioRepository(bindings.database);
  const timestamp = isoWithoutZulu(now);
  const sessions = await repository.expiredSessions(timestamp);
  let removed = 0;
  for (const session of sessions) {
    const keys = await repository.objectKeysForSession(session.id);
    await deleteKeys(bindings.voiceAudio, keys);
    await repository.markSessionAudioDeleted(session.id, timestamp);
    removed += keys.length;
  }
  return removed;
}

export async function cleanupVoiceAudioRoute(
  request: Request,
  bindings: VoiceRuntimeBindings,
): Promise<Response> {
  const authentication = await authenticateRequest(request, bindings);
  if (authentication.response !== null) return authentication.response;
  if (authentication.user === null) {
    return apiError(request, 401, "Could not validate credentials");
  }
  const roleError = requireManagerOrAdmin(request, authentication.user.role);
  if (roleError !== null) return roleError;
  return jsonResponse(request, {
    removed_audio_objects: await cleanupExpiredVoiceAudio(bindings),
  });
}
