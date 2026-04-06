/**
 * WebSocket message protocol shared between Hub, Machine Agent, and Device.
 *
 * All messages are JSON-serialized and have a `type` field for dispatch.
 * Direction is encoded in the naming: device->hub, hub->machine, machine->hub, hub->device.
 */

// ── Session status ──────────────────────────────────────────────────────────

export type SessionStatus = "running" | "idle" | "waiting_for_input" | "error";

// ── Session metadata (stored by hub, sent to devices) ───────────────────────

export interface SessionMeta {
  sessionId: string;
  accountId: string;
  machineId: string;
  directory: string;
  status: SessionStatus;
  lastActivity: string; // ISO 8601
  lastMessagePreview: string;
  createdAt: string; // ISO 8601
}

// ── Machine info ────────────────────────────────────────────────────────────

export interface MachineInfo {
  machineId: string;
  name: string;
  online: boolean;
  lastSeen: string; // ISO 8601
}

// ── Messages: Device -> Hub ─────────────────────────────────────────────────

/** Start a new session on a machine */
export interface StartSessionMsg {
  type: "start_session";
  machineId: string;
  directory: string;
  prompt: string;
}

/** Send a follow-up prompt to an existing session */
export interface SendPromptMsg {
  type: "send_prompt";
  sessionId: string;
  prompt: string;
}

/** Respond to an AskUserQuestion or permission prompt */
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

/** Request session list */
export interface ListSessionsMsg {
  type: "list_sessions";
}

/** Request session history */
export interface GetSessionHistoryMsg {
  type: "get_session_history";
  sessionId: string;
}

/** Request machine list */
export interface ListMachinesMsg {
  type: "list_machines";
}

export type DeviceToHubMsg =
  | StartSessionMsg
  | SendPromptMsg
  | RespondToPromptMsg
  | ListSessionsMsg
  | GetSessionHistoryMsg
  | ListMachinesMsg;

// ── Messages: Hub -> Machine Agent ──────────────────────────────────────────

/** Hub tells machine to start a new Claude session */
export interface HubStartSessionMsg {
  type: "hub_start_session";
  sessionId: string;
  directory: string;
  prompt: string;
}

/** Hub forwards a follow-up prompt to the machine */
export interface HubSendPromptMsg {
  type: "hub_send_prompt";
  sessionId: string;
  prompt: string;
}

/** Hub forwards user's response to a prompt */
export interface HubRespondToPromptMsg {
  type: "hub_respond_to_prompt";
  sessionId: string;
  promptId: string;
  response: UserPromptResponse;
}

/** Hub requests message history for a session */
export interface HubGetHistoryMsg {
  type: "hub_get_history";
  sessionId: string;
  requestId: string;
}

export type HubToMachineMsg =
  | HubStartSessionMsg
  | HubSendPromptMsg
  | HubRespondToPromptMsg
  | HubGetHistoryMsg;

// ── Messages: Machine Agent -> Hub ──────────────────────────────────────────

/** Streaming text delta from Claude */
export interface StreamTextMsg {
  type: "stream_text";
  sessionId: string;
  content: string;
}

/** A tool was called */
export interface ToolCallMsg {
  type: "tool_call";
  sessionId: string;
  toolName: string;
  display: string;
}

/** Tool result */
export interface ToolResultMsg {
  type: "tool_result";
  sessionId: string;
  content: string;
}

/** Claude is asking the user a question */
export interface UserPromptMsg {
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

/** Session status changed */
export interface SessionStatusMsg {
  type: "session_status";
  sessionId: string;
  status: SessionStatus;
  lastMessagePreview?: string;
}

/** Session completed (result message from SDK) */
export interface SessionDoneMsg {
  type: "session_done";
  sessionId: string;
  sdkSessionId: string;
  numTurns: number;
  durationMs: number;
  totalCostUsd?: number;
}

/** Session error */
export interface SessionErrorMsg {
  type: "session_error";
  sessionId: string;
  error: string;
}

/** Response to history request */
export interface SessionHistoryMsg {
  type: "session_history";
  sessionId: string;
  requestId: string;
  messages: unknown[]; // SDK message format, relayed opaquely
}

/** Machine agent announces itself after connecting */
export interface MachineHelloMsg {
  type: "machine_hello";
  machineName: string;
}

export type MachineToHubMsg =
  | StreamTextMsg
  | ToolCallMsg
  | ToolResultMsg
  | UserPromptMsg
  | SessionStatusMsg
  | SessionDoneMsg
  | SessionErrorMsg
  | SessionHistoryMsg
  | MachineHelloMsg;

// ── Messages: Hub -> Device ─────────────────────────────────────────────────

/** Full session list */
export interface SessionListMsg {
  type: "session_list";
  sessions: SessionMeta[];
}

/** Machine list */
export interface MachineListMsg {
  type: "machine_list";
  machines: MachineInfo[];
}

/** Hub relays stream events from machine to device (same types) */
export type HubToDeviceMsg =
  | SessionListMsg
  | MachineListMsg
  | StreamTextMsg
  | ToolCallMsg
  | ToolResultMsg
  | UserPromptMsg
  | SessionStatusMsg
  | SessionDoneMsg
  | SessionErrorMsg
  | SessionHistoryMsg
  | { type: "error"; message: string };

// ── Auth messages ───────────────────────────────────────────────────────────

export interface AuthRegisterMsg {
  type: "auth_register";
  email: string;
  password: string;
}

export interface AuthLoginMsg {
  type: "auth_login";
  email: string;
  password: string;
}

export interface AuthTokenMsg {
  type: "auth_token";
  token: string;
  refreshToken: string;
}

export interface AuthErrorMsg {
  type: "auth_error";
  message: string;
}

export interface AuthRefreshMsg {
  type: "auth_refresh";
  refreshToken: string;
}

export type AuthMsg =
  | AuthRegisterMsg
  | AuthLoginMsg
  | AuthTokenMsg
  | AuthErrorMsg
  | AuthRefreshMsg;

// ── Utilities ───────────────────────────────────────────────────────────────

/** Type-safe message parser */
export function parseMessage<T extends { type: string }>(data: string): T {
  const msg = JSON.parse(data);
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    throw new Error("Invalid message: missing type field");
  }
  return msg as T;
}

/** Serialize a message for sending over WebSocket */
export function serializeMessage(msg: { type: string }): string {
  return JSON.stringify(msg);
}
