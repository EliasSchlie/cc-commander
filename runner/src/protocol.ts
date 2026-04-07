/**
 * Wire protocol types for the runner.
 * Defines messages the runner sends to and receives from the hub.
 * Must stay compatible with the hub's protocol definition.
 */

export type SessionStatus = "running" | "idle" | "waiting_for_input" | "error";

export type UserPromptResponse =
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "allow"; updatedInput?: Record<string, unknown> }
  | { kind: "deny"; message?: string };

// ── Messages: Hub -> Runner ──────────────────────────────────────────────

export interface HubStartSessionMsg {
  type: "hub_start_session";
  sessionId: string;
  directory: string;
  prompt: string;
}

export interface HubSendPromptMsg {
  type: "hub_send_prompt";
  sessionId: string;
  prompt: string;
}

export interface HubRespondToPromptMsg {
  type: "hub_respond_to_prompt";
  sessionId: string;
  promptId: string;
  response: UserPromptResponse;
}

export interface HubGetHistoryMsg {
  type: "hub_get_history";
  sessionId: string;
  requestId: string;
}

export type HubToRunnerMsg =
  | HubStartSessionMsg
  | HubSendPromptMsg
  | HubRespondToPromptMsg
  | HubGetHistoryMsg;

// ── Messages: Runner -> Hub ──────────────────────────────────────────────

export interface StreamTextMsg {
  type: "stream_text";
  sessionId: string;
  content: string;
}
export interface ToolCallMsg {
  type: "tool_call";
  sessionId: string;
  toolCallId: string;
  toolName: string;
  display: string;
}
export interface ToolResultMsg {
  type: "tool_result";
  sessionId: string;
  toolCallId: string;
  content: string;
}

export interface UserPromptRequestMsg {
  type: "user_prompt";
  sessionId: string;
  promptId: string;
  toolName: string;
  questions?: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string }>;
    multiSelect?: boolean;
  }>;
  title?: string;
  input?: Record<string, unknown>;
}

export interface SessionStatusMsg {
  type: "session_status";
  sessionId: string;
  status: SessionStatus;
  lastMessagePreview?: string;
}
export interface SessionDoneMsg {
  type: "session_done";
  sessionId: string;
  sdkSessionId: string;
  numTurns: number;
  durationMs: number;
  totalCostUsd?: number;
}
export interface SessionErrorMsg {
  type: "session_error";
  sessionId: string;
  error: string;
}
export interface SessionHistoryMsg {
  type: "session_history";
  sessionId: string;
  requestId: string;
  messages: unknown[];
}
export interface RunnerHelloMsg {
  type: "runner_hello";
  machineName: string;
}

export type RunnerToHubMsg =
  | StreamTextMsg
  | ToolCallMsg
  | ToolResultMsg
  | UserPromptRequestMsg
  | SessionStatusMsg
  | SessionDoneMsg
  | SessionErrorMsg
  | SessionHistoryMsg
  | RunnerHelloMsg;

// ── Parsing ─────────────────────────────────────────────────────────────

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}

function requireFields(
  msg: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const f of fields) {
    if (!isNonEmptyString(msg[f])) {
      throw new Error(
        `Invalid ${String(msg.type)}: missing or empty field "${f}"`,
      );
    }
  }
}

export function parseHubMessage(data: string): HubToRunnerMsg {
  const msg = JSON.parse(data);
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    throw new Error("Invalid message: missing type field");
  }
  switch (msg.type) {
    case "hub_start_session":
      requireFields(msg, ["sessionId", "directory", "prompt"]);
      return msg as HubStartSessionMsg;
    case "hub_send_prompt":
      requireFields(msg, ["sessionId", "prompt"]);
      return msg as HubSendPromptMsg;
    case "hub_respond_to_prompt": {
      requireFields(msg, ["sessionId", "promptId"]);
      const response = (msg as { response?: unknown }).response;
      if (
        typeof response !== "object" ||
        response === null ||
        Array.isArray(response)
      ) {
        throw new Error(
          'Invalid hub_respond_to_prompt: missing or invalid "response"',
        );
      }
      return msg as HubRespondToPromptMsg;
    }
    case "hub_get_history":
      requireFields(msg, ["sessionId", "requestId"]);
      return msg as HubGetHistoryMsg;
    default:
      throw new Error(`Unknown hub message type: ${msg.type}`);
  }
}

export function serialize(msg: { type: string }): string {
  return JSON.stringify(msg);
}
