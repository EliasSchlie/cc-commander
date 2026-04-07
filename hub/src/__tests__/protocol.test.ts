import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseClientMessage,
  parseRunnerMessage,
  serialize,
} from "../protocol.ts";

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
