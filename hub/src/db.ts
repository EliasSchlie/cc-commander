import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { SessionMeta, SessionStatus, MachineInfo } from "./protocol.ts";

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

  listMachinesForAccount(accountId: string): MachineInfo[] {
    const rows = this.db
      .prepare("SELECT id, name, last_seen FROM machines WHERE account_id = ?")
      .all(accountId) as any[];
    return rows.map((r) => ({
      machineId: r.id,
      name: r.name,
      online: false,
      lastSeen: r.last_seen,
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
        "SELECT id, account_id, machine_id, directory, status, last_activity, last_message_preview, sdk_session_id, created_at FROM sessions WHERE id = ?",
      )
      .get(id) as any;
    return row ? toSessionRow(row) : undefined;
  }

  listSessionsForAccount(accountId: string): SessionMeta[] {
    const rows = this.db
      .prepare(
        "SELECT id, account_id, machine_id, directory, status, last_activity, last_message_preview, created_at FROM sessions WHERE account_id = ? ORDER BY last_activity DESC",
      )
      .all(accountId) as any[];
    return rows.map((r) => ({
      sessionId: r.id,
      accountId: r.account_id,
      machineId: r.machine_id,
      directory: r.directory,
      status: r.status,
      lastActivity: r.last_activity,
      lastMessagePreview: r.last_message_preview,
      createdAt: r.created_at,
    }));
  }

  updateSessionStatus(
    sessionId: string,
    status: SessionStatus,
    preview?: string,
  ): void {
    if (preview !== undefined) {
      this.db
        .prepare(
          "UPDATE sessions SET status = ?, last_activity = datetime('now'), last_message_preview = ? WHERE id = ?",
        )
        .run(status, preview, sessionId);
    } else {
      this.db
        .prepare(
          "UPDATE sessions SET status = ?, last_activity = datetime('now') WHERE id = ?",
        )
        .run(status, sessionId);
    }
  }

  updateSessionSdkId(sessionId: string, sdkSessionId: string): void {
    this.db
      .prepare("UPDATE sessions SET sdk_session_id = ? WHERE id = ?")
      .run(sdkSessionId, sessionId);
  }

  /** Marks all non-idle sessions on a machine as errored. Returns the number affected. */
  markSessionsErrorForMachine(machineId: string, errorMessage: string): number {
    // Type anchor: rename a SessionStatus value and these will fail to compile.
    const errorStatus: SessionStatus = "error";
    const activeStatuses: SessionStatus[] = ["running", "waiting_for_input"];
    const placeholders = activeStatuses.map(() => "?").join(", ");
    const result = this.db
      .prepare(
        `UPDATE sessions SET status = ?, last_message_preview = ?, last_activity = datetime('now') WHERE machine_id = ? AND status IN (${placeholders})`,
      )
      .run(errorStatus, errorMessage, machineId, ...activeStatuses);
    return result.changes;
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

function toAccountRow(row: any): AccountRow {
  return {
    id: row.id,
    email: row.email,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
  };
}

function toMachineRow(row: any): MachineRow {
  return {
    id: row.id,
    accountId: row.account_id,
    name: row.name,
    registrationToken: row.registration_token,
    lastSeen: row.last_seen,
    createdAt: row.created_at,
  };
}

function toSessionRow(row: any): SessionRow {
  return {
    id: row.id,
    accountId: row.account_id,
    machineId: row.machine_id,
    directory: row.directory,
    status: row.status,
    lastActivity: row.last_activity,
    lastMessagePreview: row.last_message_preview,
    sdkSessionId: row.sdk_session_id,
    createdAt: row.created_at,
  };
}
