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
): Promise<{ status: number; data: any }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json() };
}

beforeEach(async () => {
  db = new HubDb(":memory:");
  auth = new AuthService(db, JWT_SECRET);
  hub = new Hub({ port: 0, db, auth });
  await hub.start();
  const addr = hub.httpServer.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
  baseUrl = `http://localhost:${port}`;
});

afterEach(async () => {
  await hub.stop();
  db.close();
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
