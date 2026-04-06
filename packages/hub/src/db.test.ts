import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "./db.ts";

let db: HubDb;

beforeEach(() => {
  db = new HubDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("accounts", () => {
  // Prevents: accounts created without proper fields, duplicate emails silently accepted
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

  // Prevents: accounts looked up by email returning wrong data
  it("finds account by email", () => {
    db.createAccount("test@example.com", "hash123");
    const found = db.getAccountByEmail("test@example.com");
    assert.ok(found);
    assert.equal(found.email, "test@example.com");
  });

  // Prevents: non-existent accounts returning garbage data
  it("returns undefined for unknown email", () => {
    const found = db.getAccountByEmail("unknown@example.com");
    assert.equal(found, undefined);
  });
});

describe("machines", () => {
  let accountId: string;

  beforeEach(() => {
    const account = db.createAccount("test@example.com", "hash");
    accountId = account.id;
  });

  // Prevents: machines created without registration tokens
  it("creates a machine with registration token", () => {
    const machine = db.createMachine(accountId, "My MacBook");
    assert.ok(machine.id);
    assert.ok(machine.registrationToken);
    assert.equal(machine.name, "My MacBook");
    assert.equal(machine.accountId, accountId);
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
    assert.ok(machines.every((m) => m.name.startsWith("Machine")));
  });
});

describe("sessions", () => {
  let accountId: string;
  let machineId: string;

  beforeEach(() => {
    const account = db.createAccount("test@example.com", "hash");
    accountId = account.id;
    const machine = db.createMachine(accountId, "Test Machine");
    machineId = machine.id;
  });

  // Prevents: sessions created with wrong defaults
  it("creates a session with idle status", () => {
    const session = db.createSession(accountId, machineId, "/projects/foo");
    assert.ok(session.id);
    assert.equal(session.status, "idle");
    assert.equal(session.directory, "/projects/foo");
    assert.equal(session.machineId, machineId);
    assert.equal(session.accountId, accountId);
  });

  // Prevents: session status updates not being persisted
  it("updates session status and preview", () => {
    const session = db.createSession(accountId, machineId, "/tmp");
    db.updateSessionStatus(session.id, "running", "Working on it...");
    const updated = db.getSessionById(session.id)!;
    assert.equal(updated.status, "running");
    assert.equal(updated.lastMessagePreview, "Working on it...");
  });

  // Prevents: session list not ordered by last activity
  it("lists sessions ordered by last activity", () => {
    const s1 = db.createSession(accountId, machineId, "/a");
    const s2 = db.createSession(accountId, machineId, "/b");
    // Update s1 to be more recent
    db.updateSessionStatus(s1.id, "running");

    const sessions = db.listSessionsForAccount(accountId);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, s1.id); // s1 was updated more recently
  });

  // Prevents: SDK session ID not being stored for resume
  it("stores SDK session ID", () => {
    const session = db.createSession(accountId, machineId, "/tmp");
    db.updateSessionSdkId(session.id, "sdk-uuid-123");
    const updated = db.getSessionById(session.id)!;
    assert.equal(updated.sdkSessionId, "sdk-uuid-123");
  });
});

describe("refresh tokens", () => {
  // Prevents: refresh tokens not being stored/retrieved correctly
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
