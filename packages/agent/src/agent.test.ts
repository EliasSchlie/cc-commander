import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { MachineAgent } from "./agent.ts";
import type { HubToMachineMsg, MachineToHubMsg } from "@cc-commander/shared";

let mockHub: ReturnType<typeof createServer>;
let wss: WebSocketServer;
let hubPort: number;
let machineSocket: WebSocket | null;

function waitForMachineMsg(
  predicate?: (m: any) => boolean,
  timeoutMs = 3000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!machineSocket) return reject(new Error("No machine connected"));
    const timer = setTimeout(() => {
      machineSocket!.off("message", handler);
      reject(new Error("Timeout waiting for machine message"));
    }, timeoutMs);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        machineSocket!.off("message", handler);
        resolve(msg);
      }
    };
    machineSocket.on("message", handler);
  });
}

function sendToMachine(msg: HubToMachineMsg): void {
  if (machineSocket && machineSocket.readyState === WebSocket.OPEN) {
    machineSocket.send(JSON.stringify(msg));
  }
}

/** Creates a mock query function that yields given messages then completes */
function mockQuery(messages: any[]) {
  return function fakeSdkQuery({ prompt, options }: any) {
    async function* gen() {
      for (const msg of messages) {
        yield msg;
      }
    }
    return gen();
  } as any;
}

/** Creates a mock query that simulates a full assistant turn */
function mockQueryWithResult(text: string, sessionId = "sdk-session-1") {
  return mockQuery([
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
    },
    {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    },
    {
      type: "result",
      subtype: "success",
      session_id: sessionId,
      num_turns: 1,
      duration_ms: 100,
      total_cost_usd: 0.001,
    },
  ]);
}

/** Creates a mock query that calls canUseTool with AskUserQuestion */
function mockQueryWithQuestion(question: string) {
  return function fakeSdkQuery({ prompt, options }: any) {
    async function* gen() {
      // Call canUseTool to simulate AskUserQuestion
      if (options.canUseTool) {
        const result = await options.canUseTool(
          "AskUserQuestion",
          {
            questions: [
              { question, options: [{ label: "Yes" }, { label: "No" }] },
            ],
          },
          { signal: new AbortController().signal },
        );
        // Yield a result after the question is answered
        yield {
          type: "result",
          subtype: "success",
          session_id: "sdk-session-q",
          num_turns: 1,
          duration_ms: 50,
          total_cost_usd: 0.001,
        };
      }
    }
    return gen();
  } as any;
}

beforeEach(async () => {
  machineSocket = null;
  mockHub = createServer();
  wss = new WebSocketServer({ server: mockHub });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (
      url.pathname === "/ws/machine" &&
      url.searchParams.get("token") === "test-token"
    ) {
      machineSocket = ws;
    } else {
      ws.close(4001, "Unauthorized");
    }
  });

  await new Promise<void>((resolve) => {
    mockHub.listen(0, () => {
      const addr = mockHub.address();
      hubPort = typeof addr === "object" && addr ? addr.port : 0;
      resolve();
    });
  });
});

afterEach(async () => {
  await new Promise<void>((resolve, reject) => {
    wss.close(() => {
      mockHub.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  });
});

describe("MachineAgent connection", () => {
  // Prevents: agent failing to connect to hub or not sending hello
  it("connects to hub and sends machine_hello", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test Machine",
    });

    await agent.connect();

    const msg = await waitForMachineMsg();
    assert.equal(msg.type, "machine_hello");
    assert.equal(msg.machineName, "Test Machine");

    agent.disconnect();
  });
});

describe("session lifecycle", () => {
  // Prevents: agent not sending stream events from SDK to hub
  it("streams text from SDK query to hub", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test Machine",
      queryFn: mockQueryWithResult("Hello world!"),
    });

    await agent.connect();
    await waitForMachineMsg((m) => m.type === "machine_hello");

    // Collect all messages
    const allMsgs: any[] = [];
    machineSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToMachine({
      type: "hub_start_session",
      sessionId: "s1",
      directory: "/tmp",
      prompt: "Hello",
    });

    // Wait for session to complete
    await new Promise((r) => setTimeout(r, 300));

    const statusMsg = allMsgs.find(
      (m) => m.type === "session_status" && m.status === "running",
    );
    assert.ok(
      statusMsg,
      `Expected session_status running, got: ${allMsgs.map((m) => m.type + ":" + (m.status || "")).join(", ")}`,
    );

    const streamMsg = allMsgs.find((m) => m.type === "stream_text");
    assert.ok(streamMsg, "Expected stream_text message");
    assert.equal(streamMsg.content, "Hello world!");

    const doneMsg = allMsgs.find((m) => m.type === "session_done");
    assert.ok(doneMsg, "Expected session_done message");
    assert.equal(doneMsg.sdkSessionId, "sdk-session-1");
    assert.equal(doneMsg.numTurns, 1);

    agent.disconnect();
  });

  // Prevents: tool calls not being relayed to device via hub
  it("relays tool calls from SDK to hub", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test Machine",
      queryFn: mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "file1.txt\nfile2.txt" }],
          },
        },
        {
          type: "result",
          session_id: "sdk-2",
          num_turns: 1,
          duration_ms: 200,
        },
      ]),
    });

    await agent.connect();
    await waitForMachineMsg((m) => m.type === "machine_hello");

    const allMsgs: any[] = [];
    machineSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToMachine({
      type: "hub_start_session",
      sessionId: "s2",
      directory: "/tmp",
      prompt: "List files",
    });

    await new Promise((r) => setTimeout(r, 300));

    const toolCallMsg = allMsgs.find((m) => m.type === "tool_call");
    assert.ok(toolCallMsg, "Expected tool_call message");
    assert.equal(toolCallMsg.toolName, "Bash");
    assert.equal(toolCallMsg.display, "$ ls -la");

    const toolResultMsg = allMsgs.find((m) => m.type === "tool_result");
    assert.ok(toolResultMsg, "Expected tool_result message");
    assert.match(toolResultMsg.content, /file1\.txt/);

    agent.disconnect();
  });

  // Prevents: user questions not being relayed to device, or answers not reaching SDK
  it("relays AskUserQuestion to hub and resolves with answer", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test Machine",
      queryFn: mockQueryWithQuestion("Continue?"),
    });

    await agent.connect();
    await waitForMachineMsg((m) => m.type === "machine_hello");

    const allMsgs: any[] = [];
    machineSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToMachine({
      type: "hub_start_session",
      sessionId: "s3",
      directory: "/tmp",
      prompt: "Do something",
    });

    // Wait for the user_prompt to arrive
    await new Promise((r) => setTimeout(r, 300));

    const promptMsg = allMsgs.find((m) => m.type === "user_prompt");
    assert.ok(
      promptMsg,
      `Expected user_prompt, got: ${allMsgs.map((m) => m.type).join(", ")}`,
    );
    assert.equal(promptMsg.toolName, "AskUserQuestion");
    assert.equal(promptMsg.questions[0].question, "Continue?");

    // Verify status changed to waiting_for_input
    const waitingMsg = allMsgs.find(
      (m) => m.type === "session_status" && m.status === "waiting_for_input",
    );
    assert.ok(waitingMsg, "Expected waiting_for_input status");

    // Send response from "device" via hub
    sendToMachine({
      type: "hub_respond_to_prompt",
      sessionId: "s3",
      promptId: promptMsg.promptId,
      response: { kind: "answers", answers: { "Continue?": "Yes" } },
    });

    // Wait for session to complete
    await new Promise((r) => setTimeout(r, 300));

    const doneMsg = allMsgs.find((m) => m.type === "session_done");
    assert.ok(doneMsg, "Expected session_done after answering question");

    agent.disconnect();
  });
});

describe("history", () => {
  // Prevents: history requests for sessions without SDK ID returning errors
  it("returns empty history for unknown session", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test Machine",
    });

    await agent.connect();
    await waitForMachineMsg((m) => m.type === "machine_hello");

    sendToMachine({
      type: "hub_get_history",
      sessionId: "nonexistent",
      requestId: "req-1",
    });

    const historyMsg = await waitForMachineMsg(
      (m) => m.type === "session_history",
    );
    assert.equal(historyMsg.requestId, "req-1");
    assert.deepEqual(historyMsg.messages, []);

    agent.disconnect();
  });
});
