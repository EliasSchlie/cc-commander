import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseClientMessage,
  parseRunnerMessage,
  parseHubMessage,
  serialize,
} from "../index.ts";

describe("parseClientMessage", () => {
  // Prevents: malformed messages crashing downstream handlers
  it("parses a valid start_session message", () => {
    const msg = parseClientMessage(
      '{"type":"start_session","machineId":"m1","directory":"/tmp","prompt":"hello"}',
    );
    assert.equal(msg.type, "start_session");
  });

  // Prevents: messages without type being silently accepted
  it("throws on missing type field", () => {
    assert.throws(() => parseClientMessage('{"foo":"bar"}'), /missing type/);
  });

  // Prevents: unknown message types being silently accepted
  it("throws on unknown message type", () => {
    assert.throws(
      () => parseClientMessage('{"type":"hack_system"}'),
      /Unknown client message type/,
    );
  });

  // Prevents: messages with missing required fields passing validation
  it("throws on missing required fields", () => {
    assert.throws(
      () => parseClientMessage('{"type":"start_session","machineId":"m1"}'),
      /Missing required field/,
    );
  });

  // Prevents: list_sessions (no required fields) being rejected
  it("accepts messages with no required fields", () => {
    const msg = parseClientMessage('{"type":"list_sessions"}');
    assert.equal(msg.type, "list_sessions");
  });

  it("parses a valid delete_session message", () => {
    const msg = parseClientMessage(
      '{"type":"delete_session","sessionId":"s1"}',
    );
    assert.equal(msg.type, "delete_session");
    if (msg.type === "delete_session") {
      assert.equal(msg.sessionId, "s1");
    }
  });

  it("rejects delete_session without sessionId", () => {
    assert.throws(
      () => parseClientMessage('{"type":"delete_session"}'),
      /Missing required field: sessionId/,
    );
  });

  // Symmetric with parseHubMessage's hub_respond_to_prompt check.
  it("rejects respond_to_prompt with non-object response", () => {
    assert.throws(
      () =>
        parseClientMessage(
          '{"type":"respond_to_prompt","sessionId":"s1","promptId":"p","response":"yes"}',
        ),
      /missing or invalid "response"/,
    );
  });

  // Prevents: invalid JSON crashing instead of throwing cleanly
  it("throws on invalid JSON", () => {
    assert.throws(() => parseClientMessage("not json"), {
      name: "SyntaxError",
    });
  });
});

describe("parseRunnerMessage", () => {
  // Prevents: runner messages with missing fields passing through
  it("validates runner message fields", () => {
    const msg = parseRunnerMessage(
      '{"type":"stream_text","sessionId":"s1","content":"hello"}',
    );
    assert.equal(msg.type, "stream_text");
  });

  // Prevents: runner_hello without machineName being accepted
  it("rejects runner_hello without machineName", () => {
    assert.throws(
      () => parseRunnerMessage('{"type":"runner_hello"}'),
      /Missing required field: machineName/,
    );
  });

  // Prevents: session_done without sdkSessionId being accepted
  it("rejects session_done without sdkSessionId", () => {
    assert.throws(
      () => parseRunnerMessage('{"type":"session_done","sessionId":"s1"}'),
      /Missing required field: sdkSessionId/,
    );
  });

  // Prevents: tool_call slipping through without toolCallId, breaking
  // result-by-id correlation downstream (see #9)
  it("rejects tool_call without toolCallId", () => {
    assert.throws(
      () =>
        parseRunnerMessage(
          '{"type":"tool_call","sessionId":"s1","toolName":"Read","display":"x"}',
        ),
      /Missing required field: toolCallId/,
    );
  });

  it("rejects tool_result without toolCallId", () => {
    assert.throws(
      () =>
        parseRunnerMessage(
          '{"type":"tool_result","sessionId":"s1","content":"x"}',
        ),
      /Missing required field: toolCallId/,
    );
  });

  it("accepts tool_call and tool_result with toolCallId", () => {
    const call = parseRunnerMessage(
      '{"type":"tool_call","sessionId":"s1","toolCallId":"tc1","toolName":"Read","display":"x"}',
    );
    assert.equal(call.type, "tool_call");
    const result = parseRunnerMessage(
      '{"type":"tool_result","sessionId":"s1","toolCallId":"tc1","content":"x"}',
    );
    assert.equal(result.type, "tool_result");
  });

  it("accepts dropped_tool_block with all fields", () => {
    const msg = parseRunnerMessage(
      '{"type":"dropped_tool_block","sessionId":"s1","blockType":"tool_use","reason":"missing_id"}',
    );
    assert.equal(msg.type, "dropped_tool_block");
  });

  it("rejects dropped_tool_block without reason", () => {
    assert.throws(
      () =>
        parseRunnerMessage(
          '{"type":"dropped_tool_block","sessionId":"s1","blockType":"tool_use"}',
        ),
      /Missing required field: reason/,
    );
  });

  // A misbehaving runner could otherwise inject arbitrary tokens into
  // hub log lines and (in A3) metric label keys. Validate the closed
  // (blockType, reason) pair set at the boundary.
  it("rejects dropped_tool_block with unknown blockType", () => {
    assert.throws(
      () =>
        parseRunnerMessage(
          '{"type":"dropped_tool_block","sessionId":"s1","blockType":"banana","reason":"missing_id"}',
        ),
      /unknown \(blockType, reason\) pair/,
    );
  });

  it("rejects dropped_tool_block with mismatched (blockType, reason)", () => {
    assert.throws(
      () =>
        parseRunnerMessage(
          '{"type":"dropped_tool_block","sessionId":"s1","blockType":"tool_use","reason":"missing_tool_use_id"}',
        ),
      /unknown \(blockType, reason\) pair/,
    );
  });

  it("rejects session_history with unknown error code", () => {
    assert.throws(
      () =>
        parseRunnerMessage(
          '{"type":"session_history","sessionId":"s1","requestId":"r1","messages":[],"error":"banana"}',
        ),
      /unknown error code/,
    );
  });

  // Degraded session_history replies must carry a stable error code so
  // clients can branch on it (e.g. render "history unavailable: timeout").
  it("accepts session_history with error code", () => {
    const msg = parseRunnerMessage(
      '{"type":"session_history","sessionId":"s1","requestId":"r1","messages":[],"error":"fetch_failed"}',
    );
    assert.equal(msg.type, "session_history");
    assert.equal((msg as { error?: string }).error, "fetch_failed");
  });

  it("accepts session_history without error field", () => {
    const msg = parseRunnerMessage(
      '{"type":"session_history","sessionId":"s1","requestId":"r1","messages":[]}',
    );
    assert.equal(msg.type, "session_history");
    assert.equal((msg as { error?: string }).error, undefined);
  });
});

describe("parseHubMessage", () => {
  // Prevents: runner accepting malformed hub commands
  it("parses a valid hub_start_session", () => {
    const msg = parseHubMessage(
      '{"type":"hub_start_session","sessionId":"s1","directory":"/tmp","prompt":"hi"}',
    );
    assert.equal(msg.type, "hub_start_session");
  });

  it("throws on unknown hub message type", () => {
    assert.throws(
      () => parseHubMessage('{"type":"hub_drop_table"}'),
      /Unknown hub message type/,
    );
  });

  it("rejects hub_get_history without requestId", () => {
    assert.throws(
      () => parseHubMessage('{"type":"hub_get_history","sessionId":"s1"}'),
      /Missing required field: requestId/,
    );
  });

  // Prevents: regression after #29 unification -- the pre-#29
  // runner-side parser rejected empty strings via isNonEmptyString.
  // The hub-style validateFields only checks `!== undefined`, which
  // would silently accept "" and produce broken sessions downstream.
  // parseHubMessage tightens the check back for hub→runner traffic.
  it("rejects hub_start_session with empty sessionId", () => {
    assert.throws(
      () =>
        parseHubMessage(
          '{"type":"hub_start_session","sessionId":"","directory":"/tmp","prompt":"hi"}',
        ),
      /must be a non-empty string/,
    );
  });

  it("rejects hub_get_history with empty requestId", () => {
    assert.throws(
      () =>
        parseHubMessage(
          '{"type":"hub_get_history","sessionId":"s1","requestId":""}',
        ),
      /must be a non-empty string/,
    );
  });

  // Prevents: response field passing the generic check while being a
  // string/array/null instead of an object
  it("rejects hub_respond_to_prompt with non-object response", () => {
    assert.throws(
      () =>
        parseHubMessage(
          '{"type":"hub_respond_to_prompt","sessionId":"s1","promptId":"p","response":"yes"}',
        ),
      /missing or invalid "response"/,
    );
  });

  it("accepts hub_respond_to_prompt with object response", () => {
    const msg = parseHubMessage(
      '{"type":"hub_respond_to_prompt","sessionId":"s1","promptId":"p","response":{"kind":"deny"}}',
    );
    assert.equal(msg.type, "hub_respond_to_prompt");
  });
});

describe("serialize", () => {
  // Prevents: messages sent in wrong format
  it("serializes a message to JSON", () => {
    const json = serialize({
      type: "stream_text",
      sessionId: "s1",
      content: "hi",
    });
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, "stream_text");
    assert.equal(parsed.content, "hi");
  });
});
