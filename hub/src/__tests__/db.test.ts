import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HubDb, sqliteToIso8601 } from "../db.ts";

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

let db: HubDb;

beforeEach(() => {
  db = new HubDb(":memory:");
});
afterEach(() => {
  db.close();
});

describe("accounts", () => {
  // Prevents: accounts created without proper fields
  it("creates and retrieves an account", () => {
    const account = db.createAccount("test@example.com", "hash123");
    assert.ok(account.id);
    assert.equal(account.email, "test@example.com");
    assert.equal(account.passwordHash, "hash123");
  });

  // Prevents: duplicate email accounts causing data corruption
  it("rejects duplicate emails", () => {
    db.createAccount("test@example.com", "hash123");
    assert.throws(() => db.createAccount("test@example.com", "hash456"));
  });

  // Prevents: non-existent accounts returning garbage data
  it("returns undefined for unknown email", () => {
    assert.equal(db.getAccountByEmail("unknown@example.com"), undefined);
  });
});

describe("machines", () => {
  let accountId: string;
  beforeEach(() => {
    accountId = db.createAccount("test@example.com", "hash").id;
  });

  // Prevents: machines created without registration tokens
  it("creates a machine with registration token", () => {
    const machine = db.createMachine(accountId, "My MacBook");
    assert.ok(machine.id);
    assert.ok(machine.registrationToken);
    assert.equal(machine.name, "My MacBook");
  });

  // Prevents: machine lookup by token returning wrong machine
  it("finds machine by registration token", () => {
    const machine = db.createMachine(accountId, "My MacBook");
    const found = db.getMachineByToken(machine.registrationToken);
    assert.ok(found);
    assert.equal(found.id, machine.id);
  });

  // Prevents: machine list returning machines from other accounts
  it("lists machines for account only", () => {
    db.createMachine(accountId, "Machine 1");
    db.createMachine(accountId, "Machine 2");
    const other = db.createAccount("other@example.com", "hash");
    db.createMachine(other.id, "Other Machine");
    const machines = db.listMachinesForAccount(accountId);
    assert.equal(machines.length, 2);
  });
});

describe("sessions", () => {
  let accountId: string;
  let machineId: string;
  beforeEach(() => {
    accountId = db.createAccount("test@example.com", "hash").id;
    machineId = db.createMachine(accountId, "Test Machine").id;
  });

  // Prevents: sessions created with wrong defaults
  it("creates a session with default idle status", () => {
    const session = db.createSession(accountId, machineId, "/projects/foo");
    assert.equal(session.status, "idle");
    assert.equal(session.directory, "/projects/foo");
  });

  // Prevents: sessions not accepting initial status
  it("creates a session with custom initial status", () => {
    const session = db.createSession(accountId, machineId, "/tmp", "running");
    assert.equal(session.status, "running");
  });

  // Prevents: session status updates not being persisted
  it("updates session status and preview", () => {
    const session = db.createSession(accountId, machineId, "/tmp");
    db.updateSessionStatus(session.id, "running", "Working...");
    const updated = db.getSessionById(session.id)!;
    assert.equal(updated.status, "running");
    assert.equal(updated.lastMessagePreview, "Working...");
  });

  // Prevents: SDK session ID not being stored for resume
  it("stores SDK session ID", () => {
    const session = db.createSession(accountId, machineId, "/tmp");
    db.updateSessionSdkId(session.id, "sdk-uuid-123");
    const updated = db.getSessionById(session.id)!;
    assert.equal(updated.sdkSessionId, "sdk-uuid-123");
  });

  // Prevents: sessions stuck in 'running' forever after the runner disconnects.
  // Previously these were marked as `error: Runner disconnected`, but the
  // SDK conversation jsonl on disk is intact so the runner can resume on
  // reconnect (see hub_runner_resync). Idle is the honest description.
  it("demotes non-idle sessions to idle for a machine", () => {
    const running = db.createSession(accountId, machineId, "/a", "running");
    const waiting = db.createSession(
      accountId,
      machineId,
      "/b",
      "waiting_for_input",
    );
    const idle = db.createSession(accountId, machineId, "/c", "idle");
    const errored = db.createSession(accountId, machineId, "/d", "error");

    // Seed previews so we can verify they survive the demotion -- the
    // sidebar should still show "...applying patch" not "Runner gone".
    db.updateSessionStatus(running.id, "running", "Edit foo.ts");
    db.updateSessionStatus(waiting.id, "waiting_for_input", "Run tests?");

    const affected = db.markSessionsIdleForMachine(machineId);
    assert.equal(affected, 2);

    assert.equal(db.getSessionById(running.id)!.status, "idle");
    assert.equal(
      db.getSessionById(running.id)!.lastMessagePreview,
      "Edit foo.ts",
    );
    assert.equal(db.getSessionById(waiting.id)!.status, "idle");
    assert.equal(
      db.getSessionById(waiting.id)!.lastMessagePreview,
      "Run tests?",
    );
    // idle and already-errored sessions are untouched
    assert.equal(db.getSessionById(idle.id)!.status, "idle");
    assert.equal(db.getSessionById(errored.id)!.status, "error");
  });

  // Prevents: marking sessions on one machine accidentally affecting another machine
  it("only idles sessions on the specified machine", () => {
    const otherMachine = db.createMachine(accountId, "Other").id;
    const a = db.createSession(accountId, machineId, "/a", "running");
    const b = db.createSession(accountId, otherMachine, "/b", "running");

    db.markSessionsIdleForMachine(machineId);

    assert.equal(db.getSessionById(a.id)!.status, "idle");
    assert.equal(db.getSessionById(b.id)!.status, "running");
  });

  // Prevents: runner reconnect not getting back its sdkSessionId map,
  // which would cause the next prompt on a pre-existing session to
  // start a fresh SDK conversation with no `resume:`.
  it("lists resumable sessions for a machine", () => {
    const a = db.createSession(accountId, machineId, "/a", "idle");
    const b = db.createSession(accountId, machineId, "/b", "idle");
    const c = db.createSession(accountId, machineId, "/c", "idle");
    db.updateSessionSdkId(a.id, "sdk-a");
    db.updateSessionSdkId(b.id, "sdk-b");
    // c has no sdk_session_id -- excluded

    const resumable = db.listResumableSessionsForMachine(machineId);
    const ids = new Set(resumable.map((r) => r.sessionId));
    assert.equal(resumable.length, 2);
    assert.ok(ids.has(a.id));
    assert.ok(ids.has(b.id));
    assert.ok(!ids.has(c.id));
    const aEntry = resumable.find((r) => r.sessionId === a.id)!;
    assert.equal(aEntry.sdkSessionId, "sdk-a");
  });

  it("excludes archived sessions from the resumable list", () => {
    const a = db.createSession(accountId, machineId, "/a", "idle");
    db.updateSessionSdkId(a.id, "sdk-a");
    db.archiveSession(a.id, accountId);

    const resumable = db.listResumableSessionsForMachine(machineId);
    assert.equal(resumable.length, 0);
  });
});

describe("refresh tokens", () => {
  // Prevents: refresh tokens not stored/retrieved correctly
  it("creates and retrieves a refresh token", () => {
    const account = db.createAccount("test@example.com", "hash");
    const token = db.createRefreshToken(account.id, "2030-01-01T00:00:00Z");
    const found = db.getRefreshToken(token);
    assert.ok(found);
    assert.equal(found.accountId, account.id);
  });

  // Prevents: deleted refresh tokens still being valid
  it("deletes a refresh token", () => {
    const account = db.createAccount("test@example.com", "hash");
    const token = db.createRefreshToken(account.id, "2030-01-01T00:00:00Z");
    db.deleteRefreshToken(token);
    assert.equal(db.getRefreshToken(token), undefined);
  });
});

describe("ISO8601 timestamp wire format", () => {
  // Prevents: SQLite's default `YYYY-MM-DD HH:MM:SS` format leaking into
  // JSON broadcasts. Swift's JSONDecoder.dateDecodingStrategy = .iso8601
  // can't parse the SQLite shape and silently drops the entire enclosing
  // message, which manifests as "no machines online" in the macOS app.
  it("sqliteToIso8601 converts SQLite datetime format to ISO8601", () => {
    assert.equal(
      sqliteToIso8601("2026-04-07 10:56:55"),
      "2026-04-07T10:56:55Z",
    );
  });

  // Prevents: future schema migration to ISO-native breaking the converter
  it("sqliteToIso8601 is idempotent for already-ISO8601 input", () => {
    assert.equal(
      sqliteToIso8601("2026-04-07T10:56:55Z"),
      "2026-04-07T10:56:55Z",
    );
  });

  it("sqliteToIso8601 passes through empty/null input", () => {
    assert.equal(sqliteToIso8601(""), "");
  });

  // Prevents: regression where listMachinesForAccount emits SQLite format
  it("listMachinesForAccount emits ISO8601 lastSeen", () => {
    const account = db.createAccount("test@example.com", "hash");
    db.createMachine(account.id, "Test Machine");
    const machines = db.listMachinesForAccount(account.id);
    assert.equal(machines.length, 1);
    assert.match(machines[0].lastSeen, ISO8601_RE);
  });

  // Prevents: regression where listSessionsForAccount emits SQLite format
  it("listSessionsForAccount emits ISO8601 lastActivity and createdAt", () => {
    const account = db.createAccount("test@example.com", "hash");
    const machine = db.createMachine(account.id, "Test");
    db.createSession(account.id, machine.id, "/tmp", "idle");
    const sessions = db.listSessionsForAccount(account.id);
    assert.equal(sessions.length, 1);
    assert.match(sessions[0].lastActivity, ISO8601_RE);
    assert.match(sessions[0].createdAt, ISO8601_RE);
  });

  // Prevents: regression where getMachineByToken emits SQLite format
  it("getMachineByToken emits ISO8601 lastSeen and createdAt", () => {
    const account = db.createAccount("test@example.com", "hash");
    const machine = db.createMachine(account.id, "Test");
    const found = db.getMachineByToken(machine.registrationToken);
    assert.ok(found);
    assert.match(found.lastSeen, ISO8601_RE);
    assert.match(found.createdAt, ISO8601_RE);
  });
});
