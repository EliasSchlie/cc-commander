/**
 * Wire protocol shared by hub and runner. Single source of truth.
 *
 * The hub is the authority on this protocol; runners and clients must
 * conform. This package exists so the hub-side and runner-side never
 * drift -- before the extraction the same types lived in two files
 * kept in sync by hand and one PR (see #13) had to update both
 * lockstep when adding `toolCallId`.
 *
 * The Swift client has its own re-declaration in
 * `client/swift/CCCommanderPackage/Sources/CCModels/`. That can't share
 * TypeScript and is unavoidable -- but the two TypeScript sides can.
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

// ── User-prompt response (used by both directions) ──────────────────────

export type UserPromptResponse =
  | { kind: "answers"; answers: Record<string, string> }
  | { kind: "allow"; updatedInput?: Record<string, unknown> }
  | { kind: "deny"; message?: string };

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

/**
 * Stable codes for a degraded session_history reply. Literal union (not
 * bare string) so callers get exhaustive switch checks; mirrors the
 * SessionStatus pattern above.
 */
export type HistoryErrorCode = "timeout" | "no_session" | "fetch_failed";

export interface SessionHistoryMsg {
  type: "session_history";
  sessionId: string;
  requestId: string;
  messages: unknown[];
  /** Set on degraded replies; absent on healthy ones. */
  error?: HistoryErrorCode;
}

export type DroppedBlockType = "tool_use" | "tool_result";
export type DroppedBlockReason = "missing_id" | "missing_tool_use_id";

/**
 * Runner→hub signal that an SDK content block failed a runtime guard
 * and was skipped. Pure observability; hub counts these to surface SDK
 * shape drift.
 */
export interface DroppedToolBlockMsg {
  type: "dropped_tool_block";
  sessionId: string;
  blockType: DroppedBlockType;
  reason: DroppedBlockReason;
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
  | DroppedToolBlockMsg
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

export class MessageValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessageValidationError";
  }
}

const CLIENT_MSG_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  start_session: ["machineId", "directory", "prompt"],
  send_prompt: ["sessionId", "prompt"],
  respond_to_prompt: ["sessionId", "promptId", "response"],
  list_sessions: [],
  get_session_history: ["sessionId"],
  list_machines: [],
};

const RUNNER_MSG_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  stream_text: ["sessionId", "content"],
  tool_call: ["sessionId", "toolCallId", "toolName", "display"],
  tool_result: ["sessionId", "toolCallId", "content"],
  user_prompt: ["sessionId", "promptId", "toolName"],
  session_status: ["sessionId", "status"],
  session_done: ["sessionId", "sdkSessionId"],
  session_error: ["sessionId", "error"],
  session_history: ["sessionId", "requestId", "messages"],
  dropped_tool_block: ["sessionId", "blockType", "reason"],
  runner_hello: ["machineName"],
};

const HUB_MSG_REQUIRED_FIELDS: Record<string, readonly string[]> = {
  hub_start_session: ["sessionId", "directory", "prompt"],
  hub_send_prompt: ["sessionId", "prompt"],
  hub_respond_to_prompt: ["sessionId", "promptId", "response"],
  hub_get_history: ["sessionId", "requestId"],
};

function validateFields(
  msg: Record<string, unknown>,
  fields: readonly string[],
): void {
  for (const field of fields) {
    if (!(field in msg) || msg[field] === undefined) {
      throw new MessageValidationError(`Missing required field: ${field}`);
    }
  }
}

function isObjectShape(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseEnvelope(data: string): Record<string, unknown> {
  const msg = JSON.parse(data);
  if (typeof msg !== "object" || msg === null || typeof msg.type !== "string") {
    throw new MessageValidationError("Invalid message: missing type field");
  }
  return msg as Record<string, unknown>;
}

export function parseClientMessage(data: string): ClientToHubMsg {
  const msg = parseEnvelope(data);
  const fields = CLIENT_MSG_REQUIRED_FIELDS[msg.type as string];
  if (!fields) {
    throw new MessageValidationError(
      `Unknown client message type: ${msg.type as string}`,
    );
  }
  validateFields(msg, fields);
  // Symmetric with parseHubMessage: respond_to_prompt.response must be
  // an object, not a string/array/null. Catches malformed clients
  // before hub-side handlers have to defend against it.
  if (msg.type === "respond_to_prompt" && !isObjectShape(msg.response)) {
    throw new MessageValidationError(
      'Invalid respond_to_prompt: missing or invalid "response"',
    );
  }
  return msg as unknown as ClientToHubMsg;
}

export function parseRunnerMessage(data: string): RunnerToHubMsg {
  const msg = parseEnvelope(data);
  const fields = RUNNER_MSG_REQUIRED_FIELDS[msg.type as string];
  if (!fields) {
    throw new MessageValidationError(
      `Unknown runner message type: ${msg.type as string}`,
    );
  }
  validateFields(msg, fields);
  return msg as unknown as RunnerToHubMsg;
}

export function parseHubMessage(data: string): HubToRunnerMsg {
  const msg = parseEnvelope(data);
  const fields = HUB_MSG_REQUIRED_FIELDS[msg.type as string];
  if (!fields) {
    throw new MessageValidationError(
      `Unknown hub message type: ${msg.type as string}`,
    );
  }
  validateFields(msg, fields);
  // The runner is the most exposed parser surface (it executes the
  // received commands), so it gets the strictest validation. Every
  // listed field on a hub→runner message is a string id/path/prompt
  // -- empty strings would silently produce broken sessions
  // downstream. Match the pre-#29 runner-side parser which rejected
  // them at the boundary.
  for (const field of fields) {
    if (field === "response") continue;
    if (typeof msg[field] !== "string" || (msg[field] as string).length === 0) {
      throw new MessageValidationError(
        `Invalid ${msg.type as string}: field "${field}" must be a non-empty string`,
      );
    }
  }
  // hub_respond_to_prompt carries an object `response`. The generic
  // field check only catches missing/undefined; reject non-object
  // shapes here so the runner doesn't have to defend against it.
  if (msg.type === "hub_respond_to_prompt" && !isObjectShape(msg.response)) {
    throw new MessageValidationError(
      'Invalid hub_respond_to_prompt: missing or invalid "response"',
    );
  }
  return msg as unknown as HubToRunnerMsg;
}

export function serialize<T extends { type: string }>(msg: T): string {
  return JSON.stringify(msg);
}
