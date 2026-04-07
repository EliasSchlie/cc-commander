/**
 * WebSocket message protocol for the hub.
 * Defines all messages the hub sends and receives.
 * The hub is the authority on this protocol -- runner and client must conform.
 */

// ── Session status ──────────────────────────────────────────────────────

export type SessionStatus = "running" | "idle" | "waiting_for_input" | "error";

// ── Session metadata ────────────────────────────────────────────────────

export interface SessionMeta {
  sessionId: string;
  accountId: string;
  machineId: string;
  directory: string;
  status: SessionStatus;
  lastActivity: string;
  lastMessagePreview: string;
  createdAt: string;
}

// ── Machine info ────────────────────────────────────────────────────────

export interface MachineInfo {
  machineId: string;
  name: string;
  online: boolean;
  lastSeen: string;
}

// ── Messages: Client -> Hub ─────────────────────────────────────────────

export interface StartSessionMsg {
  type: "start_session";
  machineId: string;
  directory: string;
  prompt: string;
}

export interface SendPromptMsg {
  type: "send_prompt";
  sessionId: string;
  prompt: string;
}

export interface RespondToPromptMsg {
  type: "respond_to_prompt";
  sessionId: string;
  promptId: string;
  response: UserPromptResponse;
}

export type UserPromptResponse =
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "allow"; updatedInput?: Record<string, unknown> }
  | { kind: "deny"; message?: string };

export interface ListSessionsMsg {
  type: "list_sessions";
}

export interface GetSessionHistoryMsg {
  type: "get_session_history";
  sessionId: string;
}

export interface ListMachinesMsg {
  type: "list_machines";
}

export type ClientToHubMsg =
  | StartSessionMsg
  | SendPromptMsg
  | RespondToPromptMsg
  | ListSessionsMsg
  | GetSessionHistoryMsg
  | ListMachinesMsg;

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

// ── Messages: Hub -> Client ─────────────────────────────────────────────

export interface SessionListMsg {
  type: "session_list";
  sessions: SessionMeta[];
}

export interface MachineListMsg {
  type: "machine_list";
  machines: MachineInfo[];
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

export type HubToClientMsg =
  | SessionListMsg
  | MachineListMsg
  | StreamTextMsg
  | ToolCallMsg
  | ToolResultMsg
  | UserPromptRequestMsg
  | SessionStatusMsg
  | SessionDoneMsg
  | SessionErrorMsg
  | SessionHistoryMsg
  | ErrorMsg;

// ── Validation & parsing ────────────────────────────────────────────────

const CLIENT_MSG_REQUIRED_FIELDS: Record<string, string[]> = {
  start_session: ["machineId", "directory", "prompt"],
  send_prompt: ["sessionId", "prompt"],
  respond_to_prompt: ["sessionId", "promptId", "response"],
  list_sessions: [],
  get_session_history: ["sessionId"],
  list_machines: [],
};

const RUNNER_MSG_REQUIRED_FIELDS: Record<string, string[]> = {
  stream_text: ["sessionId", "content"],
  tool_call: ["sessionId", "toolName", "display"],
  tool_result: ["sessionId", "content"],
  user_prompt: ["sessionId", "promptId", "toolName"],
  session_status: ["sessionId", "status"],
  session_done: ["sessionId", "sdkSessionId"],
  session_error: ["sessionId", "error"],
  session_history: ["sessionId", "requestId", "messages"],
  runner_hello: ["machineName"],
};

class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageValidationError";
  }
}

function validateFields(
  msg: Record<string, unknown>,
  requiredFields: string[],
): void {
  for (const field of requiredFields) {
    if (!(field in msg) || msg[field] === undefined) {
      throw new MessageValidationError(`Missing required field: ${field}`);
    }
  }
}

export function parseClientMessage(data: string): ClientToHubMsg {
  const msg = JSON.parse(data);
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    throw new MessageValidationError("Invalid message: missing type field");
  }
  const fields = CLIENT_MSG_REQUIRED_FIELDS[msg.type];
  if (!fields) {
    throw new MessageValidationError(
      `Unknown client message type: ${msg.type}`,
    );
  }
  validateFields(msg, fields);
  return msg as ClientToHubMsg;
}

export function parseRunnerMessage(data: string): RunnerToHubMsg {
  const msg = JSON.parse(data);
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    throw new MessageValidationError("Invalid message: missing type field");
  }
  const fields = RUNNER_MSG_REQUIRED_FIELDS[msg.type];
  if (!fields) {
    throw new MessageValidationError(
      `Unknown runner message type: ${msg.type}`,
    );
  }
  validateFields(msg, fields);
  return msg as RunnerToHubMsg;
}

export function serialize(msg: { type: string }): string {
  return JSON.stringify(msg);
}
