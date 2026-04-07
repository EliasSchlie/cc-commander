import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "../db.ts";

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

  // Prevents: sessions stuck in 'running' forever after the runner disconnects
  it("marks non-idle sessions as errored for a machine", () => {
    const running = db.createSession(accountId, machineId, "/a", "running");
    const waiting = db.createSession(
      accountId,
      machineId,
      "/b",
      "waiting_for_input",
    );
    const idle = db.createSession(accountId, machineId, "/c", "idle");
    const errored = db.createSession(accountId, machineId, "/d", "error");

    const affected = db.markSessionsErrorForMachine(machineId, "Runner gone");
    assert.equal(affected, 2);

    assert.equal(db.getSessionById(running.id)!.status, "error");
    assert.equal(
      db.getSessionById(running.id)!.lastMessagePreview,
      "Runner gone",
    );
    assert.equal(db.getSessionById(waiting.id)!.status, "error");
    // idle and already-errored sessions are untouched
    assert.equal(db.getSessionById(idle.id)!.status, "idle");
    assert.equal(db.getSessionById(errored.id)!.status, "error");
  });

  // Prevents: marking sessions on one machine accidentally affecting another machine
  it("only errors sessions on the specified machine", () => {
    const otherMachine = db.createMachine(accountId, "Other").id;
    const a = db.createSession(accountId, machineId, "/a", "running");
    const b = db.createSession(accountId, otherMachine, "/b", "running");

    db.markSessionsErrorForMachine(machineId, "gone");

    assert.equal(db.getSessionById(a.id)!.status, "error");
    assert.equal(db.getSessionById(b.id)!.status, "running");
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
