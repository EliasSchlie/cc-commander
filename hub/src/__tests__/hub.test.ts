import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { HubDb } from "../db.ts";
import { AuthService } from "../auth.ts";
import { Hub } from "../hub.ts";

const JWT_SECRET = "test-secret";
let db: HubDb;
let auth: AuthService;
let hub: Hub;
let port: number;
let baseUrl: string;

function connectClient(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/client?token=${token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function connectRunner(registrationToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${port}/ws/runner?token=${registrationToken}`,
    );
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function waitForMsg(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 3000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("Timeout"));
    }, timeoutMs);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (predicate(msg)) {
        clearTimeout(timer);
        ws.off("message", handler);
        resolve(msg);
      }
    };
    ws.on("message", handler);
  });
}

function send(ws: WebSocket, msg: unknown): void {
  ws.send(JSON.stringify(msg));
}
function closeWs(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (ws.readyState === WebSocket.CLOSED) return resolve();
    ws.on("close", () => resolve());
    ws.close();
  });
}

async function postJson(
  path: string,
  body: unknown,
  bearer?: string,
): Promise<{ status: number; data: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (bearer) headers["Authorization"] = `Bearer ${bearer}`;
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

// Ample limits so existing tests don't accidentally trip the rate limiter.
// Dedicated rate-limit tests construct their own Hub with tight settings.
const TEST_RATE_LIMITS = {
  login: { capacity: 1000, perMinute: 1000 },
  register: { capacity: 1000, perMinute: 1000 },
  refresh: { capacity: 1000, perMinute: 1000 },
  machineCreate: { capacity: 1000, perHour: 1000 },
};

beforeEach(async () => {
  db = new HubDb(":memory:");
  auth = new AuthService(db, JWT_SECRET);
  hub = new Hub({ port: 0, db, auth, rateLimits: TEST_RATE_LIMITS });
  await hub.start();
  const addr = hub.httpServer.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://localhost:${port}`;
});

afterEach(async () => {
  await hub.stop();
  db.close();
});

// ── /api/version ────────────────────────────────────────────────────────

describe("GET /api/version", () => {
  // Prevents: runners can't tell if their build matches the hub's
  it("returns the configured version", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({ port: 0, db, auth, version: "v1.2.3" });
    await hub.start();
    const addr = hub.httpServer.address();
    const p = typeof addr === "object" && addr ? addr.port : 0;
    const res = await fetch(`http://localhost:${p}/api/version`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.version, "v1.2.3");
  });

  // Prevents: undefined version crashing JSON serialization
  it("returns empty string when version is unset", async () => {
    const res = await fetch(`${baseUrl}/api/version`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.version, "");
  });
});

// ── REST Auth ───────────────────────────────────────────────────────────

describe("REST auth", () => {
  // Prevents: clients unable to get tokens to connect WebSocket
  it("registers via REST and returns tokens", async () => {
    const { status, data } = await postJson("/api/auth/register", {
      email: "user@test.com",
      password: "pass123",
    });
    assert.equal(status, 200);
    assert.ok(data.token);
    assert.ok(data.refreshToken);
  });

  // Prevents: login failing after registration
  it("logs in via REST after registration", async () => {
    await postJson("/api/auth/register", {
      email: "user@test.com",
      password: "pass123",
    });
    const { status, data } = await postJson("/api/auth/login", {
      email: "user@test.com",
      password: "pass123",
    });
    assert.equal(status, 200);
    assert.ok(data.token);
  });

  // Prevents: duplicate registration succeeding
  it("returns 409 on duplicate registration", async () => {
    await postJson("/api/auth/register", {
      email: "user@test.com",
      password: "pass",
    });
    const { status } = await postJson("/api/auth/register", {
      email: "user@test.com",
      password: "other",
    });
    assert.equal(status, 409);
  });

  // Prevents: login with wrong credentials succeeding
  it("returns 401 on wrong credentials", async () => {
    await postJson("/api/auth/register", {
      email: "user@test.com",
      password: "pass",
    });
    const { status } = await postJson("/api/auth/login", {
      email: "user@test.com",
      password: "wrong",
    });
    assert.equal(status, 401);
  });

  // Prevents: refresh endpoint not working
  it("refreshes tokens via REST", async () => {
    const reg = await postJson("/api/auth/register", {
      email: "user@test.com",
      password: "pass",
    });
    const { status, data } = await postJson("/api/auth/refresh", {
      refreshToken: reg.data.refreshToken,
    });
    assert.equal(status, 200);
    assert.ok(data.token);
    assert.notEqual(data.refreshToken, reg.data.refreshToken);
  });

  // Prevents: missing fields not returning 400
  it("returns 400 on missing fields", async () => {
    const { status } = await postJson("/api/auth/register", {
      email: "user@test.com",
    });
    assert.equal(status, 400);
  });

  // Prevents: REST token not working for WebSocket
  it("REST token works for WebSocket connection", async () => {
    const { data } = await postJson("/api/auth/register", {
      email: "user@test.com",
      password: "pass",
    });
    const ws = await connectClient(data.token);
    assert.equal(ws.readyState, WebSocket.OPEN);
    await closeWs(ws);
  });
});

// ── WebSocket Auth ──────────────────────────────────────────────────────

describe("WebSocket auth", () => {
  // Prevents: unauthenticated clients accessing the system
  it("rejects client without token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/client`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
    });
    assert.equal(code, 4001);
  });

  // Prevents: unregistered runners connecting
  it("rejects runner with invalid token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/runner?token=fake`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
    });
    assert.equal(code, 4001);
  });

  // Prevents: JWT in URL query string showing up in access logs
  it("accepts client token via Authorization header", async () => {
    const tokens = await auth.register("hdr@test.com", "password");
    const ws = new WebSocket(`ws://localhost:${port}/ws/client`, {
      headers: { Authorization: `Bearer ${tokens.token}` },
    });
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => resolve());
      ws.on("error", reject);
    });
    assert.equal(ws.readyState, WebSocket.OPEN);
    ws.close();
  });
});

// ── Message validation ──────────────────────────────────────────────────

describe("message validation", () => {
  // Prevents: invalid messages crashing the hub instead of returning error
  it("returns error for invalid client message", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const ws = await connectClient(tokens.token);

    // Drain initial messages (session_list + machine_list)
    const init: any[] = [];
    await new Promise<void>((resolve) => {
      const h = (data: Buffer) => {
        init.push(JSON.parse(data.toString()));
        if (init.length >= 2) {
          ws.off("message", h);
          resolve();
        }
      };
      ws.on("message", h);
      setTimeout(() => {
        ws.off("message", h);
        resolve();
      }, 1000);
    });

    const errPromise = waitForMsg(ws, (m) => m.type === "error");
    send(ws, { type: "start_session" }); // missing required fields
    const msg = await errPromise;
    assert.equal(msg.type, "error");
    assert.match(msg.message, /Missing required field/);

    await closeWs(ws);
  });
});

// ── Session lifecycle ───────────────────────────────────────────────────

describe("session lifecycle", () => {
  // Prevents: session start not reaching runner, or runner response not reaching client
  it("starts a session and relays stream events", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");

    const runnerWs = await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);

    // Drain initial messages
    const allInit: any[] = [];
    const initDone = new Promise<void>((resolve) => {
      const h = (data: Buffer) => {
        allInit.push(JSON.parse(data.toString()));
        if (allInit.length >= 2) {
          clientWs.off("message", h);
          resolve();
        }
      };
      clientWs.on("message", h);
      setTimeout(() => {
        clientWs.off("message", h);
        resolve();
      }, 1000);
    });
    await initDone;

    const clientMsgs: any[] = [];
    clientWs.on("message", (data) => {
      clientMsgs.push(JSON.parse(data.toString()));
    });

    const runnerMsgPromise = new Promise<any>((resolve) => {
      runnerWs.once("message", (data) => resolve(JSON.parse(data.toString())));
    });

    send(clientWs, {
      type: "start_session",
      machineId: machine.id,
      directory: "/projects/test",
      prompt: "Hello",
    });
    const cmd = await runnerMsgPromise;
    assert.equal(cmd.type, "hub_start_session");
    assert.ok(cmd.sessionId);

    send(runnerWs, {
      type: "stream_text",
      sessionId: cmd.sessionId,
      content: "Hello! ",
    });
    send(runnerWs, {
      type: "session_done",
      sessionId: cmd.sessionId,
      sdkSessionId: "sdk-1",
      numTurns: 1,
      durationMs: 100,
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.ok(
      clientMsgs.find((m) => m.type === "stream_text"),
      "Expected stream_text",
    );
    assert.ok(
      clientMsgs.find((m) => m.type === "session_done"),
      "Expected session_done",
    );

    const session = db.getSessionById(cmd.sessionId)!;
    assert.equal(session.status, "idle");
    assert.equal(session.sdkSessionId, "sdk-1");

    await closeWs(runnerWs);
    await closeWs(clientWs);
  });
});

// ── Account isolation ───────────────────────────────────────────────────

describe("account isolation", () => {
  // Prevents: cross-account access to machines
  it("prevents client from using another accounts machine", async () => {
    const tokens1 = await auth.register("user1@test.com", "pass");
    await auth.register("user2@test.com", "pass");
    const account2 = db.getAccountByEmail("user2@test.com")!;
    const machine2 = db.createMachine(account2.id, "Machine 2");

    const runnerWs = await connectRunner(machine2.registrationToken);
    const clientWs = await connectClient(tokens1.token);

    const errorPromise = waitForMsg(clientWs, (m) => m.type === "error");
    send(clientWs, {
      type: "start_session",
      machineId: machine2.id,
      directory: "/tmp",
      prompt: "hack",
    });
    const msg = await errorPromise;
    assert.match(msg.message, /not found/i);

    await closeWs(runnerWs);
    await closeWs(clientWs);
  });
});

// ── Runner reconnect ─────────────────────────────────────────────────────

describe("runner reconnect", () => {
  // Prevents: runner appearing offline after reconnect (race on close handler)
  it("handles runner reconnect without losing the new connection", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");

    const runner1 = await connectRunner(machine.registrationToken);
    const runner2 = await connectRunner(machine.registrationToken);

    // Wait for runner1 close event to propagate
    await new Promise((r) => setTimeout(r, 200));

    // runner2 should still be connected, and hub should know it
    // Collect messages from the moment the WebSocket connects
    const msgs: any[] = [];
    const clientWs = await new Promise<WebSocket>((resolve, reject) => {
      const ws = new WebSocket(
        `ws://localhost:${port}/ws/client?token=${tokens.token}`,
      );
      ws.on("message", (data) => {
        msgs.push(JSON.parse(data.toString()));
      });
      ws.on("open", () => resolve(ws));
      ws.on("error", reject);
    });

    // Wait for initial messages to arrive
    await new Promise<void>((resolve) => {
      const check = () => {
        if (msgs.length >= 2) resolve();
        else setTimeout(check, 50);
      };
      check();
      setTimeout(resolve, 1000);
    });

    const machineList = msgs.find((m) => m.type === "machine_list");
    assert.ok(
      machineList,
      `Expected machine_list in: ${msgs.map((m) => m.type).join(", ")}`,
    );
    assert.equal(machineList.machines.length, 1);
    assert.equal(
      machineList.machines[0].online,
      true,
      `Machine should be online, runners map has runner2`,
    );

    await closeWs(runner1);
    await closeWs(runner2);
    await closeWs(clientWs);
  });
});

// ── Machine registration ────────────────────────────────────────────────

describe("machine registration", () => {
  // Prevents: clients having no way to add a machine end-to-end
  it("creates a machine via POST /api/machines and returns the registration token", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const { status, data } = await postJson(
      "/api/machines",
      { name: "MacBook" },
      tokens.token,
    );
    assert.equal(status, 201);
    assert.ok(data.machineId);
    assert.equal(data.name, "MacBook");
    assert.ok(data.registrationToken);

    // Token must actually work to connect a runner
    const runnerWs = await connectRunner(data.registrationToken);
    assert.equal(runnerWs.readyState, WebSocket.OPEN);
    await closeWs(runnerWs);
  });

  // Prevents: unauthenticated machine creation
  it("rejects machine creation without bearer token", async () => {
    const { status } = await postJson("/api/machines", { name: "X" });
    assert.equal(status, 401);
  });

  // Prevents: machine creation with invalid bearer token
  it("rejects machine creation with invalid bearer token", async () => {
    const { status } = await postJson(
      "/api/machines",
      { name: "X" },
      "garbage",
    );
    assert.equal(status, 401);
  });

  // Prevents: empty/missing name silently creating an unnamed machine
  it("rejects machine creation without a name", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const { status } = await postJson(
      "/api/machines",
      { name: "  " },
      tokens.token,
    );
    assert.equal(status, 400);
  });

  // Prevents: connected clients not seeing newly added machines
  it("broadcasts updated machine list to connected clients", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const clientWs = await connectClient(tokens.token);

    // Drain initial messages
    await new Promise((r) => setTimeout(r, 200));

    const updatePromise = waitForMsg(
      clientWs,
      (m) => m.type === "machine_list" && m.machines.length === 1,
    );
    await postJson("/api/machines", { name: "VPS" }, tokens.token);
    const update = await updatePromise;
    assert.equal(update.machines[0].name, "VPS");

    await closeWs(clientWs);
  });
});

// ── Runner disconnect → session cleanup ─────────────────────────────────

describe("runner disconnect cleanup", () => {
  // Prevents: sessions stuck in 'running' forever after the runner drops
  it("marks running sessions as errored when the runner disconnects", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");

    const runnerWs = await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);

    // Start a session via the client (so it ends up in 'running')
    await new Promise((r) => setTimeout(r, 100));
    send(clientWs, {
      type: "start_session",
      machineId: machine.id,
      directory: "/tmp",
      prompt: "Hi",
    });
    await new Promise((r) => setTimeout(r, 100));

    // Confirm session is running
    const sessions = db.listSessionsForAccount(account.id);
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].status, "running");
    const sessionId = sessions[0].sessionId;

    // Now drop the runner. Client should see updated session list with status=error.
    const errorListPromise = waitForMsg(
      clientWs,
      (m) =>
        m.type === "session_list" &&
        m.sessions.some(
          (s: any) => s.sessionId === sessionId && s.status === "error",
        ),
    );
    await closeWs(runnerWs);
    const errorList = await errorListPromise;
    const errored = errorList.sessions.find(
      (s: any) => s.sessionId === sessionId,
    );
    assert.equal(errored.status, "error");
    assert.equal(errored.lastMessagePreview, "Runner disconnected");

    // DB persists the error state
    const persisted = db.getSessionById(sessionId)!;
    assert.equal(persisted.status, "error");

    await closeWs(clientWs);
  });
});

// ── Per-account relay index ─────────────────────────────────────────────

describe("per-account relay index", () => {
  // #22: relay must NOT iterate every connected client. Two accounts
  // connected to the same hub: a stream_text from one account's
  // session must reach only that account's clients, with the other
  // account's client seeing nothing.
  it("does not relay account A messages to account B clients", async () => {
    const a = await auth.register("a@test.com", "pw");
    const b = await auth.register("b@test.com", "pw");
    const accountA = db.getAccountByEmail("a@test.com")!;
    const machineA = db.createMachine(accountA.id, "ma");
    const sessionA = db.createSession(accountA.id, machineA.id, "/tmp", "idle");

    const runnerA = await connectRunner(machineA.registrationToken);
    const clientA = await connectClient(a.token);
    const clientB = await connectClient(b.token);
    await new Promise((r) => setTimeout(r, 100));

    const bMessages: any[] = [];
    clientB.on("message", (data) =>
      bMessages.push(JSON.parse(data.toString())),
    );

    const aSawText = waitForMsg(
      clientA,
      (m) => m.type === "stream_text" && m.content === "hello",
    );
    runnerA.send(
      JSON.stringify({
        type: "stream_text",
        sessionId: sessionA.id,
        content: "hello",
      }),
    );
    await aSawText;

    // Give B a moment to (incorrectly) receive the relay.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(
      bMessages.find((m) => m.type === "stream_text"),
      undefined,
      "account B must not see account A's stream_text",
    );

    await closeWs(clientA);
    await closeWs(clientB);
    await closeWs(runnerA);
  });

  // #22: secondary index must drop empty buckets so a one-shot account
  // doesn't permanently grow the map. Verified via reflection on the
  // private map size.
  it("clientsByAccount drops empty buckets on disconnect", async () => {
    const a = await auth.register("a@test.com", "pw");
    const clientA = await connectClient(a.token);
    await new Promise((r) => setTimeout(r, 50));
    const idx = (hub as unknown as { clientsByAccount: Map<string, unknown> })
      .clientsByAccount;
    assert.equal(idx.size, 1);
    await closeWs(clientA);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(idx.size, 0);
  });
});

// ── Pending history request cleanup ─────────────────────────────────────

describe("pending history cleanup", () => {
  // Prevents: pendingHistoryRequests leaking entries forever when a client
  // disconnects before the runner replies
  it("clears pending history requests when the requesting client disconnects", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");
    const session = db.createSession(account.id, machine.id, "/tmp", "idle");

    const runnerWs = await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));

    // Send the history request and confirm the runner sees it
    const runnerSawRequest = new Promise<any>((resolve) => {
      runnerWs.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    send(clientWs, {
      type: "get_session_history",
      sessionId: session.id,
    });
    const req = await runnerSawRequest;
    assert.equal(req.type, "hub_get_history");
    assert.equal(hub.pendingHistory.size, 1);

    // Client disconnects before runner replies. Pending entry must be cleared.
    await closeWs(clientWs);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hub.pendingHistory.size, 0);

    await closeWs(runnerWs);
  });

  // Prevents: client spinning forever when a connected runner never replies
  // (deadlock, dropped message, runner bug). The TTL must drop the entry AND
  // notify the client so its requestId resolves.
  it("notifies client with empty history when TTL expires", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({ port: 0, db, auth, historyRequestTtlMs: 50 });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");
    const session = db.createSession(account.id, machine.id, "/tmp", "idle");

    const runnerWs = await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));

    // Runner is connected but will not reply -- swallow the request.
    runnerWs.on("message", () => {});

    const historyMsg = waitForMsg(
      clientWs,
      (m) => m.type === "session_history",
    );
    send(clientWs, { type: "get_session_history", sessionId: session.id });

    const reply = await historyMsg;
    assert.equal(reply.sessionId, session.id);
    assert.deepEqual(reply.messages, []);
    // Degraded reply must carry a stable error code so the client can
    // render e.g. "history unavailable: timeout".
    assert.equal(reply.error, "timeout");
    assert.equal(hub.pendingHistory.size, 0);

    await closeWs(clientWs);
    await closeWs(runnerWs);
  });

  // Prevents: pending history entries leaking when the runner crashes mid-request
  it("clears pending history requests when the runner disconnects", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");
    const session = db.createSession(account.id, machine.id, "/tmp", "idle");

    const runnerWs = await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));

    const runnerSawRequest = new Promise<any>((resolve) => {
      runnerWs.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    send(clientWs, { type: "get_session_history", sessionId: session.id });
    await runnerSawRequest;
    assert.equal(hub.pendingHistory.size, 1);

    // Runner drops before replying -- entry must be cleared.
    await closeWs(runnerWs);
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(hub.pendingHistory.size, 0);

    await closeWs(clientWs);
  });

  // Locks in the "observability-only, never client-facing" contract for
  // dropped_tool_block. If a future refactor accidentally routed it
  // through relayToClients we'd leak SDK shape drift to every client.
  it("does not relay dropped_tool_block to clients", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");

    const runnerWs = await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));

    const clientMsgs: any[] = [];
    clientWs.on("message", (data) =>
      clientMsgs.push(JSON.parse(data.toString())),
    );

    runnerWs.send(
      JSON.stringify({
        type: "dropped_tool_block",
        sessionId: "s1",
        blockType: "tool_use",
        reason: "missing_id",
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    assert.equal(
      clientMsgs.find((m) => m.type === "dropped_tool_block"),
      undefined,
    );

    await closeWs(clientWs);
    await closeWs(runnerWs);
  });
});

// ── Metrics integration ───────────────────────────────────────────────
//
// Verifies the four hub-side counter sites land in the Metrics snapshot
// with the expected labels. The Metrics class itself is unit-tested in
// the protocol package.
describe("metrics counters", () => {
  // Prevents: a misbehaving client crashing the parser without anyone
  // noticing the rate at which it happens.
  it("counts hub.parse_reject for malformed client messages", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 50));

    clientWs.send("not json");
    await new Promise((r) => setTimeout(r, 50));

    const snap = hub.metrics.snapshot();
    assert.equal(snap["hub.parse_reject{source=client}"], 1);

    await closeWs(clientWs);
  });

  it("counts hub.parse_reject for malformed runner messages", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "m");
    const runnerWs = await connectRunner(machine.registrationToken);
    void tokens;
    await new Promise((r) => setTimeout(r, 50));

    runnerWs.send("not json");
    await new Promise((r) => setTimeout(r, 50));

    const snap = hub.metrics.snapshot();
    assert.equal(snap["hub.parse_reject{source=runner}"], 1);

    await closeWs(runnerWs);
  });

  it("counts hub.history_ttl_expired when the TTL fires", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({ port: 0, db, auth, historyRequestTtlMs: 50 });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    const tokens = await auth.register("u@test.com", "pw");
    const account = db.getAccountByEmail("u@test.com")!;
    const machine = db.createMachine(account.id, "m");
    const session = db.createSession(account.id, machine.id, "/tmp", "idle");

    const runnerWs = await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));
    runnerWs.on("message", () => {}); // swallow, force TTL

    const replied = waitForMsg(clientWs, (m) => m.type === "session_history");
    send(clientWs, { type: "get_session_history", sessionId: session.id });
    await replied;

    assert.equal(hub.metrics.snapshot()["hub.history_ttl_expired"], 1);

    await closeWs(clientWs);
    await closeWs(runnerWs);
  });

  // Both branches of orphan: unknown requestId and machineId mismatch.
  it("counts hub.history_orphan_reply for unknown requestId", async () => {
    const tokens = await auth.register("u@test.com", "pw");
    const account = db.getAccountByEmail("u@test.com")!;
    const machine = db.createMachine(account.id, "m");
    const runnerWs = await connectRunner(machine.registrationToken);
    void tokens;
    await new Promise((r) => setTimeout(r, 50));

    runnerWs.send(
      JSON.stringify({
        type: "session_history",
        sessionId: "s1",
        requestId: "never-pending",
        messages: [],
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(hub.metrics.snapshot()["hub.history_orphan_reply"], 1);
    await closeWs(runnerWs);
  });

  // A degraded reply (runner sets `error: fetch_failed` etc) is a
  // distinct signal from an orphan reply -- operators want both rates.
  // The closed-set label keeps cardinality bounded.
  it("counts hub.history_degraded when reply carries an error code", async () => {
    const tokens = await auth.register("u@test.com", "pw");
    const account = db.getAccountByEmail("u@test.com")!;
    const machine = db.createMachine(account.id, "m");
    const session = db.createSession(account.id, machine.id, "/tmp", "idle");

    const runnerWs = await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));

    // Capture the requestId the hub generated, then reply degraded.
    const replyWhenAsked = new Promise<void>((resolve) => {
      runnerWs.once("message", (data) => {
        const msg = JSON.parse(data.toString());
        runnerWs.send(
          JSON.stringify({
            type: "session_history",
            sessionId: session.id,
            requestId: msg.requestId,
            messages: [],
            error: "fetch_failed",
          }),
        );
        resolve();
      });
    });

    const clientGotReply = waitForMsg(
      clientWs,
      (m) => m.type === "session_history",
    );
    send(clientWs, { type: "get_session_history", sessionId: session.id });
    await replyWhenAsked;
    await clientGotReply;

    const snap = hub.metrics.snapshot();
    assert.equal(snap["hub.history_degraded{code=fetch_failed}"], 1);

    await closeWs(clientWs);
    await closeWs(runnerWs);
  });

  it("counts hub.dropped_tool_block with closed-set labels", async () => {
    const tokens = await auth.register("u@test.com", "pw");
    const account = db.getAccountByEmail("u@test.com")!;
    const machine = db.createMachine(account.id, "m");
    const runnerWs = await connectRunner(machine.registrationToken);
    void tokens;
    await new Promise((r) => setTimeout(r, 50));

    runnerWs.send(
      JSON.stringify({
        type: "dropped_tool_block",
        sessionId: "s1",
        blockType: "tool_use",
        reason: "missing_id",
      }),
    );
    runnerWs.send(
      JSON.stringify({
        type: "dropped_tool_block",
        sessionId: "s1",
        blockType: "tool_result",
        reason: "missing_tool_use_id",
      }),
    );
    await new Promise((r) => setTimeout(r, 50));

    const snap = hub.metrics.snapshot();
    assert.equal(
      snap["hub.dropped_tool_block{block_type=tool_use,reason=missing_id}"],
      1,
    );
    assert.equal(
      snap[
        "hub.dropped_tool_block{block_type=tool_result,reason=missing_tool_use_id}"
      ],
      1,
    );

    await closeWs(runnerWs);
  });
});

// ── Rate limiting ───────────────────────────────────────────────────────

describe("rate limiting", () => {
  // Prevents: brute force attacks against /api/auth/login
  it("returns 429 when login attempts exceed capacity", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({
      port: 0,
      db,
      auth,
      rateLimits: {
        login: { capacity: 2, perMinute: 0.0001 },
        register: { capacity: 100, perMinute: 100 },
        machineCreate: { capacity: 100, perHour: 100 },
      },
    });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    await postJson("/api/auth/register", {
      email: "u@test.com",
      password: "pw",
    });
    // Two logins consume the bucket; third must be rate limited.
    const r1 = await postJson("/api/auth/login", {
      email: "u@test.com",
      password: "pw",
    });
    const r2 = await postJson("/api/auth/login", {
      email: "u@test.com",
      password: "pw",
    });
    const r3 = await postJson("/api/auth/login", {
      email: "u@test.com",
      password: "pw",
    });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    assert.equal(r3.status, 429);
  });

  // Prevents: registration spam from one IP
  it("returns 429 when register attempts exceed capacity", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({
      port: 0,
      db,
      auth,
      rateLimits: {
        login: { capacity: 100, perMinute: 100 },
        register: { capacity: 1, perMinute: 0.0001 },
        machineCreate: { capacity: 100, perHour: 100 },
      },
    });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    const r1 = await postJson("/api/auth/register", {
      email: "a@test.com",
      password: "pw",
    });
    const r2 = await postJson("/api/auth/register", {
      email: "b@test.com",
      password: "pw",
    });
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 429);
  });

  // Prevents: refresh-token brute force / abuse
  it("returns 429 when refresh attempts exceed capacity", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({
      port: 0,
      db,
      auth,
      rateLimits: {
        login: { capacity: 100, perMinute: 100 },
        register: { capacity: 100, perMinute: 100 },
        refresh: { capacity: 2, perMinute: 0.0001 },
        machineCreate: { capacity: 100, perHour: 100 },
      },
    });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    const r1 = await postJson("/api/auth/refresh", { refreshToken: "x" });
    const r2 = await postJson("/api/auth/refresh", { refreshToken: "x" });
    const r3 = await postJson("/api/auth/refresh", { refreshToken: "x" });
    // r1 and r2 will return 401 (bogus token) but consume the bucket;
    // r3 must hit the limiter before reaching the auth check.
    assert.equal(r1.status, 401);
    assert.equal(r2.status, 401);
    assert.equal(r3.status, 429);
  });

  // Prevents: an authenticated user spamming machine rows + tokens
  it("returns 429 when machine creation exceeds per-account quota", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({
      port: 0,
      db,
      auth,
      rateLimits: {
        login: { capacity: 100, perMinute: 100 },
        register: { capacity: 100, perMinute: 100 },
        machineCreate: { capacity: 2, perHour: 0.0001 },
      },
    });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    const tokens = await auth.register("u@test.com", "pw");
    const r1 = await postJson("/api/machines", { name: "m1" }, tokens.token);
    const r2 = await postJson("/api/machines", { name: "m2" }, tokens.token);
    const r3 = await postJson("/api/machines", { name: "m3" }, tokens.token);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r3.status, 429);
  });

  // #45: a determined attacker who creates N accounts (within the
  // strict register limit) gets N × machineCreate quota unless we add
  // a per-IP layer alongside the per-account one.
  it("returns 429 when machine creation exceeds per-IP quota across accounts", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({
      port: 0,
      db,
      auth,
      rateLimits: {
        login: { capacity: 100, perMinute: 100 },
        register: { capacity: 100, perMinute: 100 },
        // Generous per-account so it can't be the limiter we hit.
        machineCreate: { capacity: 100, perHour: 100 },
        // Tight per-IP so the test exercises the new layer.
        machineCreateIp: { capacity: 2, perHour: 0.0001 },
      },
    });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    // Two accounts from "the same IP" (localhost in tests).
    const a = await auth.register("a@test.com", "pw");
    const b = await auth.register("b@test.com", "pw");
    const r1 = await postJson("/api/machines", { name: "m1" }, a.token);
    const r2 = await postJson("/api/machines", { name: "m2" }, b.token);
    // Third request from EITHER account must hit the IP layer.
    const r3 = await postJson("/api/machines", { name: "m3" }, a.token);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 201);
    assert.equal(r3.status, 429);
    assert.equal(
      hub.metrics.snapshot()["hub.rate_limited{limiter=machine_ip}"],
      1,
    );
  });

  // #45: WS upgrade endpoints have no auth-side rate limit. Even
  // rejected upgrades have non-zero cost (socket alloc, handshake, FD).
  // Per-IP cap rejects with 429 BEFORE the upgrade completes.
  it("returns 429 on excess /ws/client upgrades from one IP", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({
      port: 0,
      db,
      auth,
      rateLimits: {
        ...TEST_RATE_LIMITS,
        wsUpgrade: { capacity: 2, perMinute: 0.0001 },
      },
    });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    const tokens = await auth.register("u@test.com", "pw");
    const ws1 = await connectClient(tokens.token);
    const ws2 = await connectClient(tokens.token);
    // Third upgrade attempt must hit the limiter and be rejected at
    // the HTTP layer with a 429.
    let rejected = false;
    let statusCode = 0;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(
        `ws://localhost:${port}/ws/client?token=${tokens.token}`,
      );
      ws.on("unexpected-response", (_req, res) => {
        rejected = true;
        statusCode = res.statusCode ?? 0;
        resolve();
      });
      ws.on("open", () => resolve());
      ws.on("error", () => resolve());
    });
    assert.equal(rejected, true, "third upgrade should have been rejected");
    assert.equal(statusCode, 429);
    // Metric must reflect the rejection so operators can tell a 429
    // spike from a flat connection-count graph.
    assert.equal(
      hub.metrics.snapshot()["hub.rate_limited{limiter=ws_upgrade}"],
      1,
    );

    await closeWs(ws1);
    await closeWs(ws2);
  });

  // The verifyClient hook covers /ws/client and /ws/runner alike — lock
  // the runner branch so a future split between client/runner upgrades
  // doesn't silently lose the limit on one side.
  it("returns 429 on excess /ws/runner upgrades from one IP", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({
      port: 0,
      db,
      auth,
      rateLimits: {
        ...TEST_RATE_LIMITS,
        wsUpgrade: { capacity: 1, perMinute: 0.0001 },
      },
    });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    const tokens = await auth.register("u@test.com", "pw");
    const account = db.getAccountByEmail("u@test.com")!;
    const machine = db.createMachine(account.id, "m");
    void tokens;

    const ws1 = await connectRunner(machine.registrationToken);
    let rejected = false;
    let statusCode = 0;
    await new Promise<void>((resolve) => {
      const ws = new WebSocket(
        `ws://localhost:${port}/ws/runner?token=${machine.registrationToken}`,
      );
      ws.on("unexpected-response", (_req, res) => {
        rejected = true;
        statusCode = res.statusCode ?? 0;
        resolve();
      });
      ws.on("open", () => resolve());
      ws.on("error", () => resolve());
    });
    assert.equal(rejected, true);
    assert.equal(statusCode, 429);

    await closeWs(ws1);
  });

  // Independent-consumption invariant: when the IP layer has tokens
  // but the per-account layer is empty, the per-account layer must
  // still reject. This is asserted positively (not just by absence)
  // so a future short-circuit can't silently re-introduce a bypass.
  it("per-account rejection still fires when IP layer has tokens", async () => {
    await hub.stop();
    db.close();
    db = new HubDb(":memory:");
    auth = new AuthService(db, JWT_SECRET);
    hub = new Hub({
      port: 0,
      db,
      auth,
      rateLimits: {
        login: { capacity: 100, perMinute: 100 },
        register: { capacity: 100, perMinute: 100 },
        // Tight per-account, generous per-IP.
        machineCreate: { capacity: 1, perHour: 0.0001 },
        machineCreateIp: { capacity: 100, perHour: 100 },
      },
    });
    await hub.start();
    const addr = hub.httpServer.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
    baseUrl = `http://localhost:${port}`;

    const tokens = await auth.register("u@test.com", "pw");
    const r1 = await postJson("/api/machines", { name: "m1" }, tokens.token);
    const r2 = await postJson("/api/machines", { name: "m2" }, tokens.token);
    assert.equal(r1.status, 201);
    assert.equal(r2.status, 429);
    assert.equal(
      hub.metrics.snapshot()["hub.rate_limited{limiter=machine_account}"],
      1,
    );
  });
});

// ── Input validation ────────────────────────────────────────────────────

describe("input validation", () => {
  // Prevents: clients passing parent-segment paths through to the runner
  // (defence-in-depth; the runner is the actual sandbox)
  it("rejects start_session with a non-absolute directory", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");
    await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));

    const errorPromise = waitForMsg(
      clientWs,
      (m) => m.type === "error" && /directory/i.test(m.message),
    );
    send(clientWs, {
      type: "start_session",
      machineId: machine.id,
      directory: "relative/path",
      prompt: "hi",
    });
    await errorPromise;
    assert.equal(db.listSessionsForAccount(account.id).length, 0);

    await closeWs(clientWs);
  });

  // Prevents: `..` segments sneaking through path validation
  it("rejects start_session with a parent-segment directory", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");
    await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));

    const errorPromise = waitForMsg(
      clientWs,
      (m) => m.type === "error" && /directory/i.test(m.message),
    );
    send(clientWs, {
      type: "start_session",
      machineId: machine.id,
      directory: "/var/data/../../etc",
      prompt: "hi",
    });
    await errorPromise;
    assert.equal(db.listSessionsForAccount(account.id).length, 0);

    await closeWs(clientWs);
  });

  // Prevents: an attacker registering machines with absurdly long names that
  // could break UI rendering or balloon broadcast payloads
  it("rejects machine creation with an over-long name", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const longName = "x".repeat(200);
    const { status } = await postJson(
      "/api/machines",
      { name: longName },
      tokens.token,
    );
    assert.equal(status, 400);
  });
});

// ── session_history reply routing ───────────────────────────────────────

describe("session_history reply routing", () => {
  // Prevents: a buggy or malicious runner spamming fabricated session_history
  // messages and having the hub broadcast them to every client on the account
  it("drops session_history with unknown requestId instead of broadcasting", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");
    const session = db.createSession(account.id, machine.id, "/tmp", "idle");

    const runnerWs = await connectRunner(machine.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));

    let received = false;
    clientWs.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "session_history") received = true;
    });

    // Runner sends an unsolicited session_history with a fabricated requestId
    runnerWs.send(
      JSON.stringify({
        type: "session_history",
        sessionId: session.id,
        requestId: "fabricated-id",
        messages: [{ role: "assistant", content: "leaked" }],
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(received, false);

    await closeWs(clientWs);
    await closeWs(runnerWs);
  });

  // Prevents: a second runner on the same account replying to a pending
  // history request that was actually directed at the first runner
  it("drops session_history when the replying machineId doesn't match", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machineA = db.createMachine(account.id, "A");
    const machineB = db.createMachine(account.id, "B");
    const sessionOnA = db.createSession(
      account.id,
      machineA.id,
      "/tmp",
      "idle",
    );

    const runnerA = await connectRunner(machineA.registrationToken);
    const runnerB = await connectRunner(machineB.registrationToken);
    const clientWs = await connectClient(tokens.token);
    await new Promise((r) => setTimeout(r, 100));

    // Capture the requestId the hub sends to runnerA
    const aSawRequest = new Promise<any>((resolve) => {
      runnerA.once("message", (data) => resolve(JSON.parse(data.toString())));
    });
    send(clientWs, { type: "get_session_history", sessionId: sessionOnA.id });
    const req = await aSawRequest;
    assert.equal(req.type, "hub_get_history");
    const stolenRequestId = req.requestId;

    let received = false;
    clientWs.on("message", (data) => {
      const m = JSON.parse(data.toString());
      if (m.type === "session_history") received = true;
    });

    // Runner B replies with the requestId that was sent to runner A
    runnerB.send(
      JSON.stringify({
        type: "session_history",
        sessionId: sessionOnA.id,
        requestId: stolenRequestId,
        messages: [{ role: "assistant", content: "spoofed" }],
      }),
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(received, false);
    // The pending entry should still be there (not consumed by the bogus reply)
    assert.equal(hub.pendingHistory.size, 1);

    await closeWs(clientWs);
    await closeWs(runnerA);
    await closeWs(runnerB);
  });
});

// ── /api/debug/state ────────────────────────────────────────────────────

describe("GET /api/debug/state", () => {
  // Prevents: anyone (incl. unauth'd internet) reading hub internals
  it("requires a bearer token", async () => {
    const res = await fetch(`${baseUrl}/api/debug/state`);
    assert.equal(res.status, 401);
  });

  it("rejects garbage tokens", async () => {
    const res = await fetch(`${baseUrl}/api/debug/state`, {
      headers: { Authorization: "Bearer not-a-real-jwt" },
    });
    assert.equal(res.status, 401);
  });

  // Prevents: snapshot regression silently dropping fields a CC
  // session relies on for autonomous debugging
  it("returns runtime snapshot for an authenticated caller", async () => {
    const tokens = await auth.register("debug@test.com", "password");
    const res = await fetch(`${baseUrl}/api/debug/state`, {
      headers: { Authorization: `Bearer ${tokens.token}` },
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as Record<string, unknown>;
    // Schema check -- if any of these go missing CC's status command
    // breaks silently, which is exactly what /api/debug/state exists
    // to prevent.
    assert.equal(typeof data.version, "string");
    assert.equal(typeof data.startedAt, "string");
    assert.equal(typeof data.uptimeSec, "number");
    assert.equal(typeof data.pid, "number");
    assert.equal(typeof data.port, "number");
    assert.ok(data.runners && typeof data.runners === "object");
    assert.ok(data.clients && typeof data.clients === "object");
    assert.equal(typeof data.pendingHistory, "number");
    assert.ok(data.memory && typeof data.memory === "object");
    assert.ok(data.metrics && typeof data.metrics === "object");
    assert.ok(Array.isArray(data.recentFailedSessions));
  });

  // Prevents: cross-account leak via /api/debug/state
  it("only returns recentFailedSessions for the requester's account", async () => {
    const a = await auth.register("a@test.com", "password");
    const b = await auth.register("b@test.com", "password");
    const machineA = db.createMachine(
      auth.verifyToken(a.token).accountId,
      "ma",
    );
    const machineB = db.createMachine(
      auth.verifyToken(b.token).accountId,
      "mb",
    );
    // Both accounts get a failed session.
    const sA = db.createSession(
      machineA.accountId,
      machineA.id,
      "/x",
      "running",
    );
    db.updateSessionStatus(sA.id, "error", "boom-A");
    const sB = db.createSession(
      machineB.accountId,
      machineB.id,
      "/y",
      "running",
    );
    db.updateSessionStatus(sB.id, "error", "boom-B");

    const res = await fetch(`${baseUrl}/api/debug/state`, {
      headers: { Authorization: `Bearer ${a.token}` },
    });
    const data = (await res.json()) as { recentFailedSessions: any[] };
    assert.equal(data.recentFailedSessions.length, 1);
    assert.equal(data.recentFailedSessions[0].errorMessage, "boom-A");
  });
});

// ── Session lifecycle persistence ───────────────────────────────────────

describe("session lifecycle in DB", () => {
  // Prevents: post-mortem queries returning stale "running" rows
  it("stamps ended_at and error_message on error", async () => {
    const tokens = await auth.register("life@test.com", "password");
    const accountId = auth.verifyToken(tokens.token).accountId;
    const machine = db.createMachine(accountId, "lab");
    const sess = db.createSession(accountId, machine.id, "/work", "running");
    db.updateSessionStatus(sess.id, "error", "the wheels came off");
    const row = db.getSessionById(sess.id);
    assert.ok(row);
    assert.equal(row!.errorMessage, "the wheels came off");
    assert.ok(row!.endedAt);
    const failed = db.listFailedSessionsForAccount(accountId);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].id, sess.id);
  });

  // Prevents: a session that recovers from error→running being mis-
  // classified as terminal in post-mortem queries
  it("clears ended_at when re-entering a non-terminal status", async () => {
    const tokens = await auth.register("recov@test.com", "password");
    const accountId = auth.verifyToken(tokens.token).accountId;
    const machine = db.createMachine(accountId, "lab");
    const sess = db.createSession(accountId, machine.id, "/w", "running");
    db.updateSessionStatus(sess.id, "idle");
    assert.ok(db.getSessionById(sess.id)!.endedAt);
    db.updateSessionStatus(sess.id, "running");
    assert.equal(db.getSessionById(sess.id)!.endedAt, null);
  });

  // Prevents: machine-disconnect → reconnect → recovery leaving the
  // recovered session stuck with the disconnect-time ended_at, which
  // would mis-classify it as "still failed" in post-mortem queries
  it("recovers ended_at after a machine disconnect mark + restart", async () => {
    const tokens = await auth.register("disco@test.com", "password");
    const accountId = auth.verifyToken(tokens.token).accountId;
    const machine = db.createMachine(accountId, "lab");
    const sess = db.createSession(accountId, machine.id, "/w", "running");
    // Simulate hub-side disconnect handling.
    const affected = db.markSessionsErrorForMachine(
      machine.id,
      "Runner disconnected",
    );
    assert.equal(affected, 1);
    const errored = db.getSessionById(sess.id)!;
    assert.equal(errored.status, "error");
    assert.equal(errored.errorMessage, "Runner disconnected");
    assert.ok(errored.endedAt);
    // Runner reconnects, session is restarted -> recovery clears ended_at.
    db.updateSessionStatus(sess.id, "running");
    const recovered = db.getSessionById(sess.id)!;
    assert.equal(recovered.status, "running");
    assert.equal(recovered.endedAt, null);
  });
});
