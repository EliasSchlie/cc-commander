/**
 * Wire protocol types for the agent.
 * Defines messages the agent sends to and receives from the hub.
 * Must stay compatible with the hub's protocol definition.
 */

export type SessionStatus = "running" | "idle" | "waiting_for_input" | "error";

export type UserPromptResponse =
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "allow"; updatedInput?: Record<string, unknown> }
  | { kind: "deny"; message?: string };

// ── Messages: Hub -> Agent ──────────────────────────────────────────────

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

export type HubToAgentMsg =
  | HubStartSessionMsg
  | HubSendPromptMsg
  | HubRespondToPromptMsg
  | HubGetHistoryMsg;

// ── Messages: Agent -> Hub ──────────────────────────────────────────────

export interface StreamTextMsg {
  type: "stream_text";
  sessionId: string;
  content: string;
}
export interface ToolCallMsg {
  type: "tool_call";
  sessionId: string;
  toolName: string;
  display: string;
}
export interface ToolResultMsg {
  type: "tool_result";
  sessionId: string;
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
export interface AgentHelloMsg {
  type: "agent_hello";
  machineName: string;
}

export type AgentToHubMsg =
  | StreamTextMsg
  | ToolCallMsg
  | ToolResultMsg
  | UserPromptRequestMsg
  | SessionStatusMsg
  | SessionDoneMsg
  | SessionErrorMsg
  | SessionHistoryMsg
  | AgentHelloMsg;

// ── Parsing ─────────────────────────────────────────────────────────────

const HUB_MSG_TYPES = new Set([
  "hub_start_session",
  "hub_send_prompt",
  "hub_respond_to_prompt",
  "hub_get_history",
]);

export function parseHubMessage(data: string): HubToAgentMsg {
  const msg = JSON.parse(data);
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    throw new Error("Invalid message: missing type field");
  }
  if (!HUB_MSG_TYPES.has(msg.type)) {
    throw new Error(`Unknown hub message type: ${msg.type}`);
  }
  return msg as HubToAgentMsg;
}

export function serialize(msg: { type: string }): string {
  return JSON.stringify(msg);
}
