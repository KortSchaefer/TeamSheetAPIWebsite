import { DurableObject } from "cloudflare:workers";

export interface AGMCoordinationResult {
  status: "ACCEPTED" | "COMPLETED" | "CONFLICT" | "BUSY";
  revision: number;
  result?: unknown;
}

export class AGMServiceRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS _sql_schema_migrations (
          id INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS service_meta (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          revision INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS commands (
          command_id TEXT PRIMARY KEY,
          expected_revision INTEGER NOT NULL,
          status TEXT NOT NULL,
          result_json TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT OR IGNORE INTO service_meta (id, revision) VALUES (1, 0);
        INSERT OR IGNORE INTO _sql_schema_migrations (id) VALUES (1);
      `);
    });
  }

  async syncRevision(revision: number): Promise<number> {
    const current = this.ctx.storage.sql.exec<{ revision: number }>(
      "SELECT revision FROM service_meta WHERE id = 1",
    ).one().revision;
    if (current === 0 && revision > 0) {
      this.ctx.storage.sql.exec("UPDATE service_meta SET revision = ? WHERE id = 1", revision);
      return revision;
    }
    return current;
  }

  async begin(commandId: string, expectedRevision: number): Promise<AGMCoordinationResult> {
    const previous = this.ctx.storage.sql.exec<{ status: string; result_json: string | null }>(
      "SELECT status, result_json FROM commands WHERE command_id = ?",
      commandId,
    ).toArray()[0];
    const revision = this.ctx.storage.sql.exec<{ revision: number }>(
      "SELECT revision FROM service_meta WHERE id = 1",
    ).one().revision;
    if (previous?.status === "COMPLETED") {
      return {
        status: "COMPLETED",
        revision,
        result: previous.result_json === null ? undefined : JSON.parse(previous.result_json),
      };
    }
    if (previous?.status === "PENDING") return { status: "ACCEPTED", revision };
    const otherPending = this.ctx.storage.sql.exec<{ count: number }>(
      "SELECT COUNT(*) AS count FROM commands WHERE status = 'PENDING'",
    ).one().count;
    if (otherPending > 0) return { status: "BUSY", revision };
    if (revision !== expectedRevision) return { status: "CONFLICT", revision };
    this.ctx.storage.sql.exec(
      "INSERT INTO commands (command_id, expected_revision, status, created_at) VALUES (?, ?, 'PENDING', ?)",
      commandId,
      expectedRevision,
      Date.now(),
    );
    return { status: "ACCEPTED", revision };
  }

  async complete(commandId: string, revision: number, result: unknown): Promise<void> {
    this.ctx.storage.sql.exec(
      "UPDATE commands SET status = 'COMPLETED', result_json = ? WHERE command_id = ?",
      JSON.stringify(result),
      commandId,
    );
    this.ctx.storage.sql.exec("UPDATE service_meta SET revision = ? WHERE id = 1", revision);
    const message = JSON.stringify({ type: "service_event", revision, result });
    for (const socket of this.ctx.getWebSockets()) {
      try { socket.send(message); } catch { /* stale sockets are removed by the runtime */ }
    }
  }

  async abort(commandId: string): Promise<void> {
    this.ctx.storage.sql.exec(
      "DELETE FROM commands WHERE command_id = ? AND status = 'PENDING'",
      commandId,
    );
  }

  async fetch(): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const revision = this.ctx.storage.sql.exec<{ revision: number }>(
      "SELECT revision FROM service_meta WHERE id = 1",
    ).one().revision;
    server.send(JSON.stringify({ type: "connected", revision }));
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message === "string" && message === "ping") socket.send("pong");
  }
}
