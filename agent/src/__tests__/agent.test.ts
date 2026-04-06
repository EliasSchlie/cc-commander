import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { MachineAgent } from "../agent.ts";
import type { HubToAgentMsg, AgentToHubMsg } from "../protocol.ts";

let mockHub: ReturnType<typeof createServer>;
let wss: WebSocketServer;
let hubPort: number;
let agentSocket: WebSocket | null;

function waitForAgentMsg(
  predicate?: (m: any) => boolean,
  timeoutMs = 3000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!agentSocket) return reject(new Error("No agent connected"));
    const timer = setTimeout(() => {
      agentSocket!.off("message", handler);
      reject(new Error("Timeout"));
    }, timeoutMs);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        agentSocket!.off("message", handler);
        resolve(msg);
      }
    };
    agentSocket.on("message", handler);
  });
}

function sendToAgent(msg: HubToAgentMsg): void {
  if (agentSocket && agentSocket.readyState === WebSocket.OPEN)
    agentSocket.send(JSON.stringify(msg));
}

function mockQuery(messages: any[]) {
  return function ({ prompt, options }: any) {
    async function* gen() {
      for (const msg of messages) yield msg;
    }
    return gen();
  } as any;
}

function mockQueryWithResult(text: string, sessionId = "sdk-session-1") {
  return mockQuery([
    {
      type: "stream_event",
      event: {
        type: "content_block_delta",
        delta: { type: "text_delta", text },
      },
    },
    { type: "assistant", message: { content: [{ type: "text", text }] } },
    {
      type: "result",
      session_id: sessionId,
      num_turns: 1,
      duration_ms: 100,
      total_cost_usd: 0.001,
    },
  ]);
}

function mockQueryWithQuestion(question: string) {
  return function ({ prompt, options }: any) {
    async function* gen() {
      if (options.canUseTool) {
        await options.canUseTool(
          "AskUserQuestion",
          {
            questions: [
              { question, options: [{ label: "Yes" }, { label: "No" }] },
            ],
          },
          { signal: new AbortController().signal },
        );
        yield {
          type: "result",
          session_id: "sdk-q",
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
  agentSocket = null;
  mockHub = createServer();
  wss = new WebSocketServer({ server: mockHub });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (
      url.pathname === "/ws/agent" &&
      url.searchParams.get("token") === "test-token"
    ) {
      agentSocket = ws;
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
      mockHub.close((err) => (err ? reject(err) : resolve()));
    });
  });
});

describe("connection", () => {
  // Prevents: agent failing to connect or not sending hello
  it("connects and sends agent_hello", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test Machine",
    });
    await agent.connect();
    const msg = await waitForAgentMsg();
    assert.equal(msg.type, "agent_hello");
    assert.equal(msg.machineName, "Test Machine");
    agent.disconnect();
  });
});

describe("session lifecycle", () => {
  // Prevents: agent not streaming SDK events to hub
  it("streams text from SDK to hub", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQueryWithResult("Hello world!"),
    });
    await agent.connect();
    await waitForAgentMsg((m) => m.type === "agent_hello");

    const allMsgs: any[] = [];
    agentSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToAgent({
      type: "hub_start_session",
      sessionId: "s1",
      directory: "/tmp",
      prompt: "Hello",
    });
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(
      allMsgs.find(
        (m) => m.type === "session_status" && m.status === "running",
      ),
      "Expected running status",
    );
    assert.ok(
      allMsgs.find((m) => m.type === "stream_text"),
      "Expected stream_text",
    );
    const done = allMsgs.find((m) => m.type === "session_done");
    assert.ok(done, "Expected session_done");
    assert.equal(done.sdkSessionId, "sdk-session-1");

    agent.disconnect();
  });

  // Prevents: tool calls not being relayed
  it("relays tool calls to hub", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
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
          message: { content: [{ type: "tool_result", content: "file1.txt" }] },
        },
        { type: "result", session_id: "sdk-2", num_turns: 1, duration_ms: 200 },
      ]),
    });
    await agent.connect();
    await waitForAgentMsg((m) => m.type === "agent_hello");

    const allMsgs: any[] = [];
    agentSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToAgent({
      type: "hub_start_session",
      sessionId: "s2",
      directory: "/tmp",
      prompt: "List files",
    });
    await new Promise((r) => setTimeout(r, 300));

    const toolCall = allMsgs.find((m) => m.type === "tool_call");
    assert.ok(toolCall);
    assert.equal(toolCall.display, "$ ls -la");
    assert.ok(allMsgs.find((m) => m.type === "tool_result"));

    agent.disconnect();
  });

  // Prevents: AskUserQuestion not being relayed, or answers not reaching SDK
  it("relays AskUserQuestion and resolves with answer", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQueryWithQuestion("Continue?"),
    });
    await agent.connect();
    await waitForAgentMsg((m) => m.type === "agent_hello");

    const allMsgs: any[] = [];
    agentSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToAgent({
      type: "hub_start_session",
      sessionId: "s3",
      directory: "/tmp",
      prompt: "Do something",
    });
    await new Promise((r) => setTimeout(r, 300));

    const promptMsg = allMsgs.find((m) => m.type === "user_prompt");
    assert.ok(promptMsg, "Expected user_prompt");
    assert.equal(promptMsg.toolName, "AskUserQuestion");
    assert.ok(
      allMsgs.find(
        (m) => m.type === "session_status" && m.status === "waiting_for_input",
      ),
    );

    sendToAgent({
      type: "hub_respond_to_prompt",
      sessionId: "s3",
      promptId: promptMsg.promptId,
      response: { kind: "answers", answers: { "Continue?": "Yes" } },
    });
    await new Promise((r) => setTimeout(r, 300));

    assert.ok(
      allMsgs.find((m) => m.type === "session_done"),
      "Expected session_done after answer",
    );
    agent.disconnect();
  });
});

describe("session history", () => {
  // Prevents: history returning empty for completed sessions
  it("returns history for completed sessions using sdkSessionIds map", async () => {
    const mockGetMessages = async (id: string, opts: any) => {
      if (id === "sdk-session-1")
        return [{ role: "user", content: "hello" }] as any;
      return [];
    };

    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQueryWithResult("Hello!", "sdk-session-1"),
      getSessionMessagesFn: mockGetMessages as any,
    });
    await agent.connect();
    await waitForAgentMsg((m) => m.type === "agent_hello");

    // Start and complete a session
    const allMsgs: any[] = [];
    agentSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToAgent({
      type: "hub_start_session",
      sessionId: "s1",
      directory: "/tmp",
      prompt: "Hello",
    });
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(
      allMsgs.find((m) => m.type === "session_done"),
      "Session should have completed",
    );

    // Now request history for the completed session
    allMsgs.length = 0;
    sendToAgent({
      type: "hub_get_history",
      sessionId: "s1",
      requestId: "req-1",
    });
    await new Promise((r) => setTimeout(r, 200));

    const historyMsg = allMsgs.find((m) => m.type === "session_history");
    assert.ok(historyMsg, "Expected session_history");
    assert.equal(historyMsg.requestId, "req-1");
    assert.equal(
      historyMsg.messages.length,
      1,
      "Should have 1 message from completed session",
    );

    agent.disconnect();
  });

  // Prevents: history request for unknown session crashing
  it("returns empty history for unknown session", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
    });
    await agent.connect();
    await waitForAgentMsg((m) => m.type === "agent_hello");

    sendToAgent({
      type: "hub_get_history",
      sessionId: "nonexistent",
      requestId: "req-1",
    });
    const msg = await waitForAgentMsg((m) => m.type === "session_history");
    assert.equal(msg.requestId, "req-1");
    assert.deepEqual(msg.messages, []);

    agent.disconnect();
  });
});

describe("protocol validation", () => {
  // Prevents: unknown message types crashing the agent
  it("ignores unknown message types", async () => {
    const agent = new MachineAgent({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
    });
    await agent.connect();
    await waitForAgentMsg((m) => m.type === "agent_hello");

    // Send unknown message type -- should not crash
    agentSocket!.send(JSON.stringify({ type: "unknown_type", data: "test" }));
    await new Promise((r) => setTimeout(r, 100));

    // Agent should still be connected
    assert.equal(agent.ws?.readyState, WebSocket.OPEN);
    agent.disconnect();
  });
});
