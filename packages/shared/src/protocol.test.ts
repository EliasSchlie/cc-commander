import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseMessage, serializeMessage } from "./protocol.ts";
import type {
  StartSessionMsg,
  StreamTextMsg,
  SessionMeta,
} from "./protocol.ts";

describe("parseMessage", () => {
  // Prevents: accepting malformed messages that crash downstream handlers
  it("parses a valid message", () => {
    const msg = parseMessage<StartSessionMsg>(
      '{"type":"start_session","machineId":"m1","directory":"/tmp","prompt":"hello"}',
    );
    assert.equal(msg.type, "start_session");
    assert.equal(msg.machineId, "m1");
    assert.equal(msg.directory, "/tmp");
    assert.equal(msg.prompt, "hello");
  });

  // Prevents: silently accepting invalid JSON, causing undefined behavior
  it("throws on invalid JSON", () => {
    assert.throws(() => parseMessage("not json"), { name: "SyntaxError" });
  });

  // Prevents: messages without type field being dispatched with undefined type
  it("throws on missing type field", () => {
    assert.throws(() => parseMessage('{"foo":"bar"}'), /missing type field/);
  });

  // Prevents: non-object values (arrays, strings) being treated as messages
  it("throws on non-object value", () => {
    assert.throws(() => parseMessage('"just a string"'), /missing type field/);
  });

  // Prevents: null being treated as a valid message
  it("throws on null", () => {
    assert.throws(() => parseMessage("null"), /missing type field/);
  });
});

describe("serializeMessage", () => {
  // Prevents: messages being sent in wrong format
  it("serializes a message to JSON", () => {
    const msg: StreamTextMsg = {
      type: "stream_text",
      sessionId: "s1",
      content: "hello world",
    };
    const json = serializeMessage(msg);
    const parsed = JSON.parse(json);
    assert.equal(parsed.type, "stream_text");
    assert.equal(parsed.sessionId, "s1");
    assert.equal(parsed.content, "hello world");
  });
});

describe("protocol type contracts", () => {
  // Prevents: SessionMeta missing required fields
  it("SessionMeta has all required fields", () => {
    const meta: SessionMeta = {
      sessionId: "s1",
      accountId: "a1",
      machineId: "m1",
      directory: "/projects/foo",
      status: "idle",
      lastActivity: new Date().toISOString(),
      lastMessagePreview: "Hello",
      createdAt: new Date().toISOString(),
    };
    assert.ok(meta.sessionId);
    assert.ok(meta.accountId);
    assert.ok(meta.machineId);
    assert.ok(meta.directory);
    assert.ok(
      ["running", "idle", "waiting_for_input", "error"].includes(meta.status),
    );
  });
});
