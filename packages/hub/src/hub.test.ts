import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { HubDb } from "./db.ts";
import { AuthService } from "./auth.ts";
import { Hub } from "./hub.ts";
import type { HubToDeviceMsg, MachineToHubMsg } from "@cc-commander/shared";

const JWT_SECRET = "test-secret";

let db: HubDb;
let auth: AuthService;
let hub: Hub;
let port: number;

function connectDevice(token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/device?token=${token}`);
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

function connectMachine(registrationToken: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://localhost:${port}/ws/machine?token=${registrationToken}`,
    );
    ws.on("open", () => resolve(ws));
    ws.on("error", reject);
  });
}

/** Collect messages until a predicate matches, with timeout */
function waitForMsg(
  ws: WebSocket,
  predicate: (msg: any) => boolean,
  timeoutMs = 3000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off("message", handler);
      reject(new Error("Timeout waiting for message"));
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

beforeEach(async () => {
  db = new HubDb(":memory:");
  auth = new AuthService(db, JWT_SECRET);
  // Use port 0 to get a random available port
  hub = new Hub({ port: 0, db, auth });
  await hub.start();
  const addr = hub.httpServer.address();
  port = typeof addr === "object" && addr ? addr.port : 0;
});

afterEach(async () => {
  await hub.stop();
  db.close();
});

describe("device connections", () => {
  // Prevents: unauthenticated devices accessing the system
  it("rejects connection without token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/device`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
    });
    assert.equal(code, 4001);
  });

  // Prevents: devices with invalid JWTs accessing sessions
  it("rejects connection with invalid token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/device?token=bad`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
    });
    assert.equal(code, 4001);
  });

  // Prevents: authenticated devices failing to connect
  it("accepts connection with valid token", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const ws = await connectDevice(tokens.token);
    assert.equal(ws.readyState, WebSocket.OPEN);
    await closeWs(ws);
  });
});

describe("machine connections", () => {
  // Prevents: unregistered machines connecting to the hub
  it("rejects connection with invalid registration token", async () => {
    const ws = new WebSocket(`ws://localhost:${port}/ws/machine?token=fake`);
    const code = await new Promise<number>((resolve) => {
      ws.on("close", (c) => resolve(c));
    });
    assert.equal(code, 4001);
  });

  // Prevents: registered machines failing to connect
  it("accepts connection with valid registration token", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");
    const ws = await connectMachine(machine.registrationToken);
    assert.equal(ws.readyState, WebSocket.OPEN);
    await closeWs(ws);
  });
});

describe("session lifecycle", () => {
  // Prevents: session start not reaching the machine, or machine response not reaching device
  it("starts a session and relays stream events", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");

    const machineWs = await connectMachine(machine.registrationToken);
    const deviceWs = await connectDevice(tokens.token);

    // Drain initial messages (session_list + machine_list from connect)
    // The device gets session_list first, then machine_list
    const allInit: any[] = [];
    const initDone = new Promise<void>((resolve) => {
      const h = (data: Buffer) => {
        allInit.push(JSON.parse(data.toString()));
        if (allInit.length >= 2) {
          deviceWs.off("message", h);
          resolve();
        }
      };
      deviceWs.on("message", h);
      setTimeout(() => {
        deviceWs.off("message", h);
        resolve();
      }, 1000);
    });
    await initDone;

    // Collect ALL device messages for debugging
    const deviceMsgs: any[] = [];
    deviceWs.on("message", (data) => {
      deviceMsgs.push(JSON.parse(data.toString()));
    });

    // Listen for machine command
    const machineMsgPromise = new Promise<any>((resolve) => {
      machineWs.once("message", (data) => resolve(JSON.parse(data.toString())));
    });

    // Device starts session
    send(deviceWs, {
      type: "start_session",
      machineId: machine.id,
      directory: "/projects/test",
      prompt: "Hello Claude",
    });

    // Machine receives command
    const cmd = await machineMsgPromise;
    assert.equal(cmd.type, "hub_start_session");
    assert.equal(cmd.directory, "/projects/test");
    assert.equal(cmd.prompt, "Hello Claude");
    assert.ok(cmd.sessionId);

    // Machine sends stream text back
    send(machineWs, {
      type: "stream_text",
      sessionId: cmd.sessionId,
      content: "Hello! ",
    } satisfies MachineToHubMsg);

    // Machine completes session
    send(machineWs, {
      type: "session_done",
      sessionId: cmd.sessionId,
      sdkSessionId: "sdk-123",
      numTurns: 1,
      durationMs: 500,
      totalCostUsd: 0.01,
    } satisfies MachineToHubMsg);

    // Wait a bit for messages to arrive
    await new Promise((r) => setTimeout(r, 200));

    // Find our messages in the collected device messages
    const streamMsg = deviceMsgs.find((m) => m.type === "stream_text");
    const doneMsg = deviceMsgs.find((m) => m.type === "session_done");

    assert.ok(
      streamMsg,
      `Expected stream_text, got: ${deviceMsgs.map((m) => m.type).join(", ")}`,
    );
    assert.equal(streamMsg.content, "Hello! ");
    assert.ok(doneMsg, `Expected session_done in messages`);
    assert.equal(doneMsg.sdkSessionId, "sdk-123");

    // Session should be idle in DB
    const session = db.getSessionById(cmd.sessionId)!;
    assert.equal(session.status, "idle");
    assert.equal(session.sdkSessionId, "sdk-123");

    await closeWs(machineWs);
    await closeWs(deviceWs);
  });
});

describe("list operations", () => {
  // Prevents: session list returning empty when sessions exist
  it("returns session list on request", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");
    db.createSession(account.id, machine.id, "/projects/test");

    const deviceWs = await connectDevice(tokens.token);

    const msgPromise = waitForMsg(
      deviceWs,
      (m) => m.type === "session_list" && m.sessions.length > 0,
    );
    send(deviceWs, { type: "list_sessions" });
    const msg = await msgPromise;

    assert.equal(msg.type, "session_list");
    assert.equal(msg.sessions.length, 1);
    assert.equal(msg.sessions[0].directory, "/projects/test");

    await closeWs(deviceWs);
  });

  // Prevents: machine list not reflecting online status
  it("returns machine list with online status", async () => {
    const tokens = await auth.register("user@test.com", "pass");
    const account = db.getAccountByEmail("user@test.com")!;
    const machine = db.createMachine(account.id, "Test Machine");

    const machineWs = await connectMachine(machine.registrationToken);
    const deviceWs = await connectDevice(tokens.token);

    // Might get initial broadcast; request explicitly
    const msgPromise = waitForMsg(
      deviceWs,
      (m) =>
        m.type === "machine_list" && m.machines.some((ma: any) => ma.online),
    );
    send(deviceWs, { type: "list_machines" });
    const msg = await msgPromise;

    assert.equal(msg.machines.length, 1);
    assert.equal(msg.machines[0].name, "Test Machine");
    assert.equal(msg.machines[0].online, true);

    await closeWs(machineWs);
    await closeWs(deviceWs);
  });
});

describe("account isolation", () => {
  // Prevents: one account seeing another account's sessions (security breach)
  it("prevents device from starting session on another accounts machine", async () => {
    const tokens1 = await auth.register("user1@test.com", "pass");
    await auth.register("user2@test.com", "pass");
    const account2 = db.getAccountByEmail("user2@test.com")!;
    const machine2 = db.createMachine(account2.id, "Machine 2");

    const machineWs = await connectMachine(machine2.registrationToken);
    const deviceWs = await connectDevice(tokens1.token);

    const errorPromise = waitForMsg(deviceWs, (m) => m.type === "error");
    send(deviceWs, {
      type: "start_session",
      machineId: machine2.id,
      directory: "/tmp",
      prompt: "hack",
    });

    const msg = await errorPromise;
    assert.equal(msg.type, "error");
    assert.match(msg.message, /not found/i);

    await closeWs(machineWs);
    await closeWs(deviceWs);
  });
});
