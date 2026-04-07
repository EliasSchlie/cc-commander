import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { WebSocket, WebSocketServer } from "ws";
import { createServer } from "node:http";
import { MachineRunner } from "../runner.ts";
import type { HubToRunnerMsg, RunnerToHubMsg } from "@cc-commander/protocol";

let mockHub: ReturnType<typeof createServer>;
let wss: WebSocketServer;
let hubPort: number;
let runnerSocket: WebSocket | null;

function waitForRunnerMsg(
  predicate?: (m: any) => boolean,
  timeoutMs = 3000,
): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!runnerSocket) return reject(new Error("No runner connected"));
    const timer = setTimeout(() => {
      runnerSocket!.off("message", handler);
      reject(new Error("Timeout"));
    }, timeoutMs);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (!predicate || predicate(msg)) {
        clearTimeout(timer);
        runnerSocket!.off("message", handler);
        resolve(msg);
      }
    };
    runnerSocket.on("message", handler);
  });
}

function sendToRunner(msg: HubToRunnerMsg): void {
  if (runnerSocket && runnerSocket.readyState === WebSocket.OPEN)
    runnerSocket.send(JSON.stringify(msg));
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
  runnerSocket = null;
  mockHub = createServer();
  wss = new WebSocketServer({ server: mockHub });
  wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (
      url.pathname === "/ws/runner" &&
      url.searchParams.get("token") === "test-token"
    ) {
      runnerSocket = ws;
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
  // Prevents: runner failing to connect or not sending hello
  it("connects and sends runner_hello", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test Machine",
    });
    await runner.connect();
    const msg = await waitForRunnerMsg();
    assert.equal(msg.type, "runner_hello");
    assert.equal(msg.machineName, "Test Machine");
    runner.disconnect();
  });
});

describe("cwd validation", () => {
  // Prevents: a misleading "Claude Code executable not found at .../cli.js"
  // error when the user supplies a directory that doesn't exist. The SDK's
  // chdir() failure surfaces as that confusing error; we want a clear
  // "directory does not exist" instead, and the SDK must never be invoked.
  it("rejects a non-existent directory with a clear error and skips the SDK", async () => {
    let queryInvoked = false;
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: ((..._args: unknown[]) => {
        queryInvoked = true;
        async function* gen() {}
        return gen();
      }) as any,
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    const errPromise = waitForRunnerMsg((m) => m.type === "session_error");
    sendToRunner({
      type: "hub_start_session",
      sessionId: "s-bad-cwd",
      directory: "/this/path/definitely/does/not/exist",
      prompt: "hi",
    });
    const err = await errPromise;
    assert.equal(err.sessionId, "s-bad-cwd");
    assert.match(err.error, /Working directory does not exist/);
    assert.equal(queryInvoked, false, "SDK must not be invoked for bad cwd");

    runner.disconnect();
  });

  // Prevents: relative paths sneaking through. The SDK would resolve them
  // against the runner process cwd, which is rarely what the user meant.
  it("rejects a relative directory path", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQueryWithResult("hi"),
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    const errPromise = waitForRunnerMsg((m) => m.type === "session_error");
    sendToRunner({
      type: "hub_start_session",
      sessionId: "s-rel",
      directory: "relative/path",
      prompt: "hi",
    });
    const err = await errPromise;
    assert.match(err.error, /absolute path/);

    runner.disconnect();
  });

  // Prevents: a regular file slipping through (e.g. user pastes a file
  // path instead of a project root).
  it("rejects a path that exists but is not a directory", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQueryWithResult("hi"),
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    // /etc/hosts exists on every test box and is a regular file.
    const errPromise = waitForRunnerMsg((m) => m.type === "session_error");
    sendToRunner({
      type: "hub_start_session",
      sessionId: "s-file",
      directory: "/etc/hosts",
      prompt: "hi",
    });
    const err = await errPromise;
    assert.match(err.error, /not a directory/);

    runner.disconnect();
  });
});

describe("session lifecycle", () => {
  // Prevents: runner not streaming SDK events to hub
  it("streams text from SDK to hub", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQueryWithResult("Hello world!"),
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    const allMsgs: any[] = [];
    runnerSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToRunner({
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

    runner.disconnect();
  });

  // Prevents: tool calls not being relayed
  it("relays tool calls to hub", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_01",
                name: "Bash",
                input: { command: "ls -la" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_01",
                content: "file1.txt",
              },
            ],
          },
        },
        { type: "result", session_id: "sdk-2", num_turns: 1, duration_ms: 200 },
      ]),
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    const allMsgs: any[] = [];
    runnerSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToRunner({
      type: "hub_start_session",
      sessionId: "s2",
      directory: "/tmp",
      prompt: "List files",
    });
    await new Promise((r) => setTimeout(r, 300));

    const toolCall = allMsgs.find((m) => m.type === "tool_call");
    assert.ok(toolCall);
    assert.equal(toolCall.display, "$ ls -la");
    assert.equal(toolCall.toolCallId, "toolu_01");
    const toolResult = allMsgs.find((m) => m.type === "tool_result");
    assert.ok(toolResult);
    assert.equal(toolResult.toolCallId, "toolu_01");

    runner.disconnect();
  });

  // When an SDK content block fails a runtime guard, the runner must
  // (a) skip the block and (b) emit dropped_tool_block so drift is
  // counted instead of seen as silence.
  it("emits dropped_tool_block when tool_use lacks an id", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", content: "out" }],
          },
        },
        { type: "result", session_id: "sdk-3", num_turns: 1, duration_ms: 10 },
      ]),
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    const allMsgs: any[] = [];
    runnerSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToRunner({
      type: "hub_start_session",
      sessionId: "s-drop",
      directory: "/tmp",
      prompt: "go",
    });
    await new Promise((r) => setTimeout(r, 300));

    const dropped = allMsgs.filter((m) => m.type === "dropped_tool_block");
    assert.equal(dropped.length, 2);
    assert.deepEqual(dropped.map((m) => m.blockType).sort(), [
      "tool_result",
      "tool_use",
    ]);
    assert.ok(dropped.every((m) => m.sessionId === "s-drop"));
    // No tool_call/tool_result must escape the guard.
    assert.equal(
      allMsgs.find((m) => m.type === "tool_call"),
      undefined,
    );
    assert.equal(
      allMsgs.find((m) => m.type === "tool_result"),
      undefined,
    );

    runner.disconnect();
  });

  // Prevents: AskUserQuestion not being relayed, or answers not reaching SDK
  it("relays AskUserQuestion and resolves with answer", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQueryWithQuestion("Continue?"),
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    const allMsgs: any[] = [];
    runnerSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToRunner({
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

    sendToRunner({
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
    runner.disconnect();
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

    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQueryWithResult("Hello!", "sdk-session-1"),
      getSessionMessagesFn: mockGetMessages as any,
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    // Start and complete a session
    const allMsgs: any[] = [];
    runnerSocket!.on("message", (data) => {
      allMsgs.push(JSON.parse(data.toString()));
    });

    sendToRunner({
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
    sendToRunner({
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

    runner.disconnect();
  });

  // Prevents: history request for unknown session crashing
  it("returns empty history for unknown session", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    sendToRunner({
      type: "hub_get_history",
      sessionId: "nonexistent",
      requestId: "req-1",
    });
    const msg = await waitForRunnerMsg((m) => m.type === "session_history");
    assert.equal(msg.requestId, "req-1");
    assert.deepEqual(msg.messages, []);
    // Empty history for an unknown session must carry the no_session
    // error code so the client can distinguish "nothing yet" from
    // "fetch failed" or "timed out".
    assert.equal(msg.error, "no_session");

    runner.disconnect();
  });
});

describe("protocol validation", () => {
  // Prevents: unknown message types crashing the runner
  it("ignores unknown message types", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    // Send unknown message type -- should not crash
    runnerSocket!.send(JSON.stringify({ type: "unknown_type", data: "test" }));
    await new Promise((r) => setTimeout(r, 100));

    // Runner should still be connected
    assert.equal(runner.ws?.readyState, WebSocket.OPEN);
    runner.disconnect();
  });

  // Prevents: malformed hub_start_session (e.g. missing directory) crashing
  // the runner inside the SDK call instead of being rejected at parse time
  it("rejects hub_start_session missing required fields", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: (() => {
        throw new Error(
          "queryFn must not be invoked for an invalid hub message",
        );
      }) as any,
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    runnerSocket!.send(
      JSON.stringify({
        type: "hub_start_session",
        sessionId: "s1",
        // missing directory + prompt
      }),
    );
    await new Promise((r) => setTimeout(r, 100));

    // Runner survived the malformed message
    assert.equal(runner.ws?.readyState, WebSocket.OPEN);
    // #44 A3: parse rejections must be counted locally so an offline
    // runner still has accounting when the hub-side counter is unreachable.
    assert.equal(runner.metrics.snapshot()["runner.parse_reject"], 1);
    runner.disconnect();
  });

  // #44 A3: dropped tool blocks must be counted on the runner side as
  // well as the hub side. The local counter is the source of truth when
  // the hub link is down or the hub-side counter resets on restart.
  it("counts runner.dropped_tool_block when guard fires", async () => {
    const runner = new MachineRunner({
      hubUrl: `ws://localhost:${hubPort}`,
      registrationToken: "test-token",
      machineName: "Test",
      queryFn: mockQuery([
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", name: "Bash", input: { command: "ls" } },
            ],
          },
        },
        { type: "result", session_id: "sdk-m", num_turns: 1, duration_ms: 5 },
      ]),
    });
    await runner.connect();
    await waitForRunnerMsg((m) => m.type === "runner_hello");

    sendToRunner({
      type: "hub_start_session",
      sessionId: "s-m",
      directory: "/tmp",
      prompt: "go",
    });
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(
      runner.metrics.snapshot()[
        "runner.dropped_tool_block{block_type=tool_use,reason=missing_id}"
      ],
      1,
    );
    runner.disconnect();
  });
});
