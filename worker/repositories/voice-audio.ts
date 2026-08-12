import type { UserRecord } from "./users";

export type VoiceAudioStatus = "PENDING" | "STORED" | "DELETED" | "MISSING";

export interface VoiceSessionAccess {
  id: number;
  manager_user_id: number;
  audio_delete_after: string | null;
}

export interface VoiceAudioRecord {
  id: number;
  session_id: number;
  upload_id: string;
  object_key: string;
  content_type: string;
  original_filename: string;
  byte_size: number | null;
  etag: string | null;
  status: VoiceAudioStatus;
  upload_expires_at: string;
  stored_at: string | null;
  deleted_at: string | null;
}

export class VoiceAudioRepository {
  constructor(private readonly database: D1Database) {}

  async sessionForUser(
    sessionId: number,
    user: UserRecord,
  ): Promise<{ session: VoiceSessionAccess | null; forbidden: boolean }> {
    const session = await this.database
      .prepare(
        `SELECT id, manager_user_id, audio_delete_after
         FROM inventory_voice_sessions WHERE id = ? LIMIT 1`,
      )
      .bind(sessionId)
      .first<VoiceSessionAccess>();
    return {
      session,
      forbidden:
        session !== null && user.role !== "ADMIN" && session.manager_user_id !== user.id,
    };
  }

  async createPending(input: {
    sessionId: number;
    uploadId: string;
    objectKey: string;
    contentType: string;
    originalFilename: string;
    uploadExpiresAt: string;
    now: string;
  }): Promise<void> {
    await this.database
      .prepare(
        `INSERT INTO inventory_voice_audio_objects
         (session_id, upload_id, object_key, content_type, original_filename,
          status, upload_expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`,
      )
      .bind(
        input.sessionId,
        input.uploadId,
        input.objectKey,
        input.contentType,
        input.originalFilename,
        input.uploadExpiresAt,
        input.now,
        input.now,
      )
      .run();
  }

  async findByUpload(sessionId: number, uploadId: string): Promise<VoiceAudioRecord | null> {
    return this.database
      .prepare(
        `SELECT id, session_id, upload_id, object_key, content_type,
                original_filename, byte_size, etag, status, upload_expires_at,
                stored_at, deleted_at
         FROM inventory_voice_audio_objects
         WHERE session_id = ? AND upload_id = ? LIMIT 1`,
      )
      .bind(sessionId, uploadId)
      .first<VoiceAudioRecord>();
  }

  async markStored(id: number, byteSize: number, etag: string, now: string): Promise<void> {
    await this.database
      .prepare(
        `UPDATE inventory_voice_audio_objects
         SET status = 'STORED', byte_size = ?, etag = ?, stored_at = ?, updated_at = ?
         WHERE id = ? AND status = 'PENDING'`,
      )
      .bind(byteSize, etag, now, now, id)
      .run();
  }

  async markMissing(record: VoiceAudioRecord, now: string): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE inventory_voice_audio_objects
           SET status = 'MISSING', updated_at = ? WHERE id = ?`,
        )
        .bind(now, record.id),
      this.database
        .prepare(
          `UPDATE inventory_voice_utterances
           SET audio_missing = 1, updated_at = ?
           WHERE session_id = ? AND audio_object_key = ?`,
        )
        .bind(now, record.session_id, record.object_key),
    ]);
  }

  async expiredSessions(now: string, limit = 100): Promise<VoiceSessionAccess[]> {
    const result = await this.database
      .prepare(
        `SELECT id, manager_user_id, audio_delete_after
         FROM inventory_voice_sessions
         WHERE audio_delete_after IS NOT NULL
           AND datetime(audio_delete_after) <= datetime(?)
         ORDER BY audio_delete_after, id LIMIT ?`,
      )
      .bind(now, limit)
      .all<VoiceSessionAccess>();
    return result.results;
  }

  async objectKeysForSession(sessionId: number): Promise<string[]> {
    const result = await this.database
      .prepare(
        `SELECT object_key FROM inventory_voice_audio_objects
         WHERE session_id = ? AND status IN ('PENDING', 'STORED', 'MISSING')
         UNION
         SELECT audio_object_key AS object_key FROM inventory_voice_utterances
         WHERE session_id = ? AND audio_object_key IS NOT NULL`,
      )
      .bind(sessionId, sessionId)
      .all<{ object_key: string }>();
    return result.results.map((row) => row.object_key);
  }

  async markSessionAudioDeleted(sessionId: number, now: string): Promise<void> {
    await this.database.batch([
      this.database
        .prepare(
          `UPDATE inventory_voice_audio_objects
           SET status = 'DELETED', deleted_at = ?, updated_at = ?
           WHERE session_id = ? AND status IN ('PENDING', 'STORED', 'MISSING')`,
        )
        .bind(now, now, sessionId),
      this.database
        .prepare(
          `UPDATE inventory_voice_utterances
           SET audio_object_key = NULL, updated_at = ?
           WHERE session_id = ? AND audio_object_key IS NOT NULL`,
        )
        .bind(now, sessionId),
      this.database
        .prepare(
          `UPDATE inventory_voice_sessions
           SET audio_delete_after = NULL, updated_at = ? WHERE id = ?`,
        )
        .bind(now, sessionId),
    ]);
  }
}
