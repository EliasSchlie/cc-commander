import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  MAX_RESUMABLE_SESSIONS,
  type SessionMeta,
  type SessionStatus,
  type MachineInfo,
  type ResumableSession,
} from "@cc-commander/protocol";

export interface AccountRow {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: string;
}

export interface MachineRow {
  id: string;
  accountId: string;
  name: string;
  registrationToken: string;
  lastSeen: string;
  createdAt: string;
}

export interface SessionRow {
  id: string;
  accountId: string;
  machineId: string;
  directory: string;
  status: SessionStatus;
  lastActivity: string;
  lastMessagePreview: string;
  sdkSessionId: string | null;
  createdAt: string;
  /** Set when status becomes "error". Null otherwise. */
  errorMessage: string | null;
  /** Set when status becomes "idle" or "error" terminally. Null while running. */
  endedAt: string | null;
}

export interface RefreshTokenRow {
  token: string;
  accountId: string;
  expiresAt: string;
  createdAt: string;
}

export class HubDb {
  private db: Database.Database;

  constructor(dbPath: string = ":memory:") {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS machines (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        name TEXT NOT NULL,
        registration_token TEXT UNIQUE NOT NULL,
        last_seen TEXT NOT NULL DEFAULT (datetime('now')),
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        machine_id TEXT NOT NULL REFERENCES machines(id),
        directory TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_activity TEXT NOT NULL DEFAULT (datetime('now')),
        last_message_preview TEXT NOT NULL DEFAULT '',
        sdk_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS refresh_tokens (
        token TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);

    // Additive migrations: SQLite has no `ADD COLUMN IF NOT EXISTS`,
    // and CREATE TABLE IF NOT EXISTS above only initializes a fresh
    // db. For existing dbs we need to detect and add the post-mortem
    // columns. Wrapped in try/catch so a re-run on a migrated db is
    // a no-op (duplicate column errors swallowed).
    this.addColumnIfMissing("sessions", "error_message", "TEXT");
    this.addColumnIfMissing("sessions", "ended_at", "TEXT");
    this.addColumnIfMissing("sessions", "archived_at", "TEXT");

    // Index supporting post-mortem queries: "show me all errored
    // sessions on machine X in the last day". Without it the
    // dashboards/CC scripts that call listFailedSessionsForAccount
    // would table-scan every row.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_account_status_ended
         ON sessions (account_id, status, ended_at);`,
    );
    // Index for the per-machine resync hot path: every runner connect
    // runs listResumableSessionsForMachine, and every disconnect runs
    // markSessionsIdleForMachine. Both filter on machine_id and need
    // an index walk instead of a table scan to scale past trivial
    // session counts. Covers the WHERE columns and the ORDER BY.
    this.db.exec(
      `CREATE INDEX IF NOT EXISTS idx_sessions_machine_resync
         ON sessions (machine_id, archived_at, last_activity DESC);`,
    );
  }

  /**
   * Idempotent ALTER TABLE ADD COLUMN. SQLite raises if the column
   * already exists, so we probe with PRAGMA table_info first instead
   * of relying on error swallowing -- cleaner stack traces if some
   * other migration error pops up later.
   */
  private addColumnIfMissing(
    table: string,
    column: string,
    sqlType: string,
  ): void {
    const cols = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name: string;
    }>;
    if (cols.some((c) => c.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
  }

  // ── Accounts ──────────────────────────────────────────────────────────

  createAccount(email: string, passwordHash: string): AccountRow {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO accounts (id, email, password_hash) VALUES (?, ?, ?)",
      )
      .run(id, email, passwordHash);
    return this.getAccountById(id)!;
  }

  getAccountByEmail(email: string): AccountRow | undefined {
    const row = this.db
      .prepare(
        "SELECT id, email, password_hash, created_at FROM accounts WHERE email = ?",
      )
      .get(email) as any;
    return row ? toAccountRow(row) : undefined;
  }

  getAccountById(id: string): AccountRow | undefined {
    const row = this.db
      .prepare(
        "SELECT id, email, password_hash, created_at FROM accounts WHERE id = ?",
      )
      .get(id) as any;
    return row ? toAccountRow(row) : undefined;
  }

  // ── Machines ──────────────────────────────────────────────────────────

  createMachine(accountId: string, name: string): MachineRow {
    const id = randomUUID();
    const registrationToken = randomUUID();
    this.db
      .prepare(
        "INSERT INTO machines (id, account_id, name, registration_token) VALUES (?, ?, ?, ?)",
      )
      .run(id, accountId, name, registrationToken);
    return this.getMachineById(id)!;
  }

  getMachineById(id: string): MachineRow | undefined {
    const row = this.db
      .prepare(
        "SELECT id, account_id, name, registration_token, last_seen, created_at FROM machines WHERE id = ?",
      )
      .get(id) as any;
    return row ? toMachineRow(row) : undefined;
  }

  getMachineByToken(token: string): MachineRow | undefined {
    const row = this.db
      .prepare(
        "SELECT id, account_id, name, registration_token, last_seen, created_at FROM machines WHERE registration_token = ?",
      )
      .get(token) as any;
    return row ? toMachineRow(row) : undefined;
  }

  listMachinesForAccount(accountId: string): Omit<MachineInfo, "online">[] {
    const rows = this.db
      .prepare("SELECT id, name, last_seen FROM machines WHERE account_id = ?")
      .all(accountId) as any[];
    return rows.map((r) => ({
      machineId: r.id,
      name: r.name,
      lastSeen: sqliteToIso8601(r.last_seen),
    }));
  }

  updateMachineLastSeen(machineId: string): void {
    this.db
      .prepare("UPDATE machines SET last_seen = datetime('now') WHERE id = ?")
      .run(machineId);
  }

  // ── Sessions ──────────────────────────────────────────────────────────

  createSession(
    accountId: string,
    machineId: string,
    directory: string,
    status: SessionStatus = "idle",
  ): SessionRow {
    const id = randomUUID();
    this.db
      .prepare(
        "INSERT INTO sessions (id, account_id, machine_id, directory, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run(id, accountId, machineId, directory, status);
    return this.getSessionById(id)!;
  }

  getSessionById(id: string): SessionRow | undefined {
    const row = this.db
      .prepare(
        "SELECT id, account_id, machine_id, directory, status, last_activity, last_message_preview, sdk_session_id, created_at, error_message, ended_at FROM sessions WHERE id = ?",
      )
      .get(id) as any;
    return row ? toSessionRow(row) : undefined;
  }

  /**
   * Post-mortem query: errored sessions for an account, newest first.
   * Used by /api/debug/state callers and CLI tooling that needs to
   * answer "what failed recently" without parsing logs. Bounded by
   * `limit` so the route doesn't accidentally serialize the entire
   * history.
   */
  listFailedSessionsForAccount(accountId: string, limit = 50): SessionRow[] {
    // ORDER BY ended_at (not COALESCE w/ last_activity): every row in
    // the result set has status='error', and updateSessionStatus +
    // markSessionsErrorForMachine both stamp ended_at when transitioning
    // into 'error', so the column is non-null here. Plain ended_at
    // matches the (account_id, status, ended_at) index exactly, so the
    // sort is satisfied by the index walk -- no extra filesort step.
    const rows = this.db
      .prepare(
        "SELECT id, account_id, machine_id, directory, status, last_activity, last_message_preview, sdk_session_id, created_at, error_message, ended_at FROM sessions WHERE account_id = ? AND status = 'error' ORDER BY ended_at DESC LIMIT ?",
      )
      .all(accountId, limit) as any[];
    return rows.map(toSessionRow);
  }

  listSessionsForAccount(accountId: string): SessionMeta[] {
    // Archived rows stay in the table for post-mortem queries
    // (listFailedSessionsForAccount, /api/debug/state) but must not
    // appear in the user's sidebar.
    const rows = this.db
      .prepare(
        "SELECT id, account_id, machine_id, directory, status, last_activity, last_message_preview, created_at FROM sessions WHERE account_id = ? AND archived_at IS NULL ORDER BY last_activity DESC",
      )
      .all(accountId) as any[];
    return rows.map((r) => ({
      sessionId: r.id,
      accountId: r.account_id,
      machineId: r.machine_id,
      directory: r.directory,
      status: r.status,
      lastActivity: sqliteToIso8601(r.last_activity),
      lastMessagePreview: r.last_message_preview,
      createdAt: sqliteToIso8601(r.created_at),
    }));
  }

  /**
   * Update a session's status, optional last-message preview, and
   * (for status='error') error_message + ended_at lifecycle columns.
   *
   * IMPORTANT: when status='error', the caller passes the human-
   * readable error string as `preview`. Hub-side message dispatch
   * (`ws/runnerMessage.ts`, the `session_error` case) does this
   * intentionally so the error text is visible in both the live
   * `last_message_preview` and the post-mortem `error_message`
   * column. The double-duty arg is historical (pre-dating
   * error_message) and kept to avoid touching every call site.
   */
  updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    preview?: string,
  ): void {
    // One UPDATE for all five (status × has-preview) combinations.
    // Previous version had 5 nearly-identical SQL branches and a
    // subtle inconsistency: the preview+non-terminal branch left
    // ended_at intact, while the no-preview+non-terminal branch
    // cleared it. Unified rules:
    //   - last_message_preview: replace if a preview was passed,
    //     otherwise keep the prior value
    //   - error_message: stamp on transition into 'error', untouched
    //     otherwise (so a recovered session keeps its diagnostic
    //     trail for post-mortem)
    //   - ended_at: stamped on transitions into terminal status
    //     (error/idle), cleared on transitions into a non-terminal
    //     status (so a running→error→running recovery doesn't show
    //     up as "still terminal" in post-mortem queries)
    const isTerminal = status === "error" || status === "idle";
    const previewParam = preview ?? null;
    this.db
      .prepare(
        `UPDATE sessions SET
           status = ?,
           last_activity = datetime('now'),
           last_message_preview = COALESCE(?, last_message_preview),
           error_message = CASE WHEN ? = 'error' THEN COALESCE(?, error_message) ELSE error_message END,
           ended_at = CASE WHEN ? = 1 THEN datetime('now') ELSE NULL END
         WHERE id = ?`,
      )
      .run(
        status,
        previewParam,
        status,
        previewParam,
        isTerminal ? 1 : 0,
        sessionId,
      );
  }

  updateSessionSdkId(sessionId: string, sdkSessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET sdk_session_id = ? WHERE id = ?")
      .run(sdkSessionId, sessionId);
  }

  /** Soft-delete: stamps `archived_at` so the row stays available for
   *  post-mortem queries (`listFailedSessionsForAccount`,
   *  `/api/debug/state`) while disappearing from `listSessionsForAccount`.
   *  Account-scoped so cross-account ids never match. Returns rows
   *  affected (0 if not found / wrong account / already archived). */
  archiveSession(sessionId: string, accountId: string): number {
    const result = this.db
      .prepare(
        "UPDATE sessions SET archived_at = datetime('now') WHERE id = ? AND account_id = ? AND archived_at IS NULL",
      )
      .run(sessionId, accountId);
    return result.changes;
  }

  /**
   * Demotes a machine's active sessions to `idle` on runner disconnect.
   * Not `error`: the SDK conversation jsonl on disk is intact and the
   * next runner connect will resync the resume map (see
   * `listResumableSessionsForMachine`). `last_message_preview` is left
   * intact so the sidebar still shows the prior activity, not
   * "disconnected". Returns the number affected.
   */
  markSessionsIdleForMachine(machineId: string): number {
    // Type anchor: rename a SessionStatus value and these will fail to compile.
    const idleStatus: SessionStatus = "idle";
    const activeStatuses: SessionStatus[] = ["running", "waiting_for_input"];
    const placeholders = activeStatuses.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE sessions SET status = ?, ended_at = datetime('now'), last_activity = datetime('now') WHERE machine_id = ? AND status IN (${placeholders})`,
      )
      .run(idleStatus, machineId, ...activeStatuses);
    return result.changes;
  }

  /**
   * Non-archived sessions on a machine that have an SDK session id, in
   * most-recently-active order. Sent on `hub_runner_resync` so the
   * runner can rebuild its `sessionId → sdkSessionId` map after a
   * restart. Capped at `MAX_RESUMABLE_SESSIONS` -- the runner's LRU
   * uses the same constant.
   */
  listResumableSessionsForMachine(
    machineId: string,
    limit = MAX_RESUMABLE_SESSIONS,
  ): ResumableSession[] {
    const rows = this.db
      .prepare(
        `SELECT id, sdk_session_id FROM sessions
           WHERE machine_id = ?
             AND archived_at IS NULL
             AND sdk_session_id IS NOT NULL
           ORDER BY last_activity DESC
           LIMIT ?`,
      )
      .all(machineId, limit) as Array<{ id: string; sdk_session_id: string }>;
    return rows.map((r) => ({
      sessionId: r.id,
      sdkSessionId: r.sdk_session_id,
    }));
  }

  // ── Refresh Tokens ────────────────────────────────────────────────────

  createRefreshToken(accountId: string, expiresAt: string): string {
    const token = randomUUID();
    this.db
      .prepare(
        "INSERT INTO refresh_tokens (token, account_id, expires_at) VALUES (?, ?, ?)",
      )
      .run(token, accountId, expiresAt);
    return token;
  }

  getRefreshToken(token: string): RefreshTokenRow | undefined {
    const row = this.db
      .prepare(
        "SELECT token, account_id, expires_at, created_at FROM refresh_tokens WHERE token = ?",
      )
      .get(token) as any;
    return row
      ? {
          token: row.token,
          accountId: row.account_id,
          expiresAt: row.expires_at,
          createdAt: row.created_at,
        }
      : undefined;
  }

  deleteRefreshToken(token: string): void {
    this.db.prepare("DELETE FROM refresh_tokens WHERE token = ?").run(token);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * SQLite's `datetime('now')` returns timestamps as `YYYY-MM-DD HH:MM:SS`
 * (no T separator, no zone). Clients expect ISO8601 (`YYYY-MM-DDTHH:MM:SSZ`)
 * because `JSONDecoder.dateDecodingStrategy = .iso8601` on Swift can't parse
 * the SQLite shape and silently drops the entire enclosing message. Convert
 * here so the SQLite format never leaks over the wire.
 *
 * Idempotent: if the input already looks ISO8601 it is returned unchanged,
 * which lets the function tolerate future schema migrations that store
 * timestamps in ISO format directly.
 */
export function sqliteToIso8601(s: string): string {
  if (!s) return s;
  if (s.includes("T")) return s; // already ISO8601
  return s.replace(" ", "T") + "Z";
}

function toAccountRow(row: any): AccountRow {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: sqliteToIso8601(row.created_at),
  };
}

function toMachineRow(row: any): MachineRow {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    registrationToken: row.registration_token,
    lastSeen: sqliteToIso8601(row.last_seen),
    createdAt: sqliteToIso8601(row.created_at),
  };
}

function toSessionRow(row: any): SessionRow {
  return {
    id: row.id,
    accountId: row.account_id,
    machineId: row.machine_id,
    directory: row.directory,
    status: row.status,
    lastActivity: sqliteToIso8601(row.last_activity),
    lastMessagePreview: row.last_message_preview,
    sdkSessionId: row.sdk_session_id,
    createdAt: sqliteToIso8601(row.created_at),
    errorMessage: row.error_message ?? null,
    endedAt: row.ended_at ? sqliteToIso8601(row.ended_at) : null,
  };
}
