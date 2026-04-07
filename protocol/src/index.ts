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

export interface ArchiveSessionMsg {
  type: "archive_session";
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
  | ArchiveSessionMsg
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

/**
 * Sent by the hub on runner (re)connect to repopulate the runner's
 * in-memory `sessionId → sdkSessionId` map from the DB. Without this,
 * a runner restart would lose all SDK session ids and the next prompt
 * on an existing session would start a fresh SDK session (no `resume:`),
 * dropping conversation history.
 *
 * Always sent immediately after the hub registers the runner connection,
 * even if the list is empty (so the runner can rely on receiving it).
 */
export interface HubRunnerResyncMsg {
  type: "hub_runner_resync";
  sessions: ResumableSession[];
}

export interface ResumableSession {
  sessionId: string;
  sdkSessionId: string;
}

export type HubToRunnerMsg =
  | HubStartSessionMsg
  | HubSendPromptMsg
  | HubRespondToPromptMsg
  | HubGetHistoryMsg
  | HubRunnerResyncMsg;

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

/**
 * Runner→hub signal that an SDK content block failed a runtime guard
 * and was skipped. Pure observability; hub counts these to surface SDK
 * shape drift. Discriminated on blockType so illegal (blockType,reason)
 * pairs are unrepresentable at compile time.
 */
export type DroppedToolBlockMsg =
  | {
      type: "dropped_tool_block";
      sessionId: string;
      blockType: "tool_use";
      reason: "missing_id";
    }
  | {
      type: "dropped_tool_block";
      sessionId: string;
      blockType: "tool_result";
      reason: "missing_tool_use_id";
    };

/** All valid (blockType, reason) pairs, used by the runtime parser. */
const DROPPED_TOOL_BLOCK_PAIRS = new Set<string>([
  "tool_use|missing_id",
  "tool_result|missing_tool_use_id",
]);

const HISTORY_ERROR_CODES = new Set<string>([
  "timeout",
  "no_session",
  "fetch_failed",
]);

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
  archive_session: ["sessionId"],
  list_machines: [],
};

// Typed by the message type union so adding a new RunnerToHubMsg variant
// without a validation entry is a compile error.
const RUNNER_MSG_REQUIRED_FIELDS: Record<
  RunnerToHubMsg["type"],
  readonly string[]
> = {
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

const HUB_MSG_REQUIRED_FIELDS: Record<
  HubToRunnerMsg["type"],
  readonly string[]
> = {
  hub_start_session: ["sessionId", "directory", "prompt"],
  hub_send_prompt: ["sessionId", "prompt"],
  hub_respond_to_prompt: ["sessionId", "promptId", "response"],
  hub_get_history: ["sessionId", "requestId"],
  hub_runner_resync: ["sessions"],
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
  const fields = RUNNER_MSG_REQUIRED_FIELDS[msg.type as RunnerToHubMsg["type"]];
  if (!fields) {
    throw new MessageValidationError(
      `Unknown runner message type: ${msg.type as string}`,
    );
  }
  validateFields(msg, fields);
  // Closed-set checks for fields whose values land in hub logs and (in
  // A3) become metric labels. Without these a misbehaving runner could
  // inject arbitrary tokens into hub-side log lines / counter keys.
  if (msg.type === "dropped_tool_block") {
    const pair = `${msg.blockType as string}|${msg.reason as string}`;
    if (!DROPPED_TOOL_BLOCK_PAIRS.has(pair)) {
      throw new MessageValidationError(
        `Invalid dropped_tool_block: unknown (blockType, reason) pair "${pair}"`,
      );
    }
  }
  if (
    msg.type === "session_history" &&
    msg.error !== undefined &&
    !HISTORY_ERROR_CODES.has(msg.error as string)
  ) {
    throw new MessageValidationError(
      `Invalid session_history: unknown error code "${msg.error as string}"`,
    );
  }
  return msg as unknown as RunnerToHubMsg;
}

export function parseHubMessage(data: string): HubToRunnerMsg {
  const msg = parseEnvelope(data);
  const fields = HUB_MSG_REQUIRED_FIELDS[msg.type as HubToRunnerMsg["type"]];
  if (!fields) {
    throw new MessageValidationError(
      `Unknown hub message type: ${msg.type as string}`,
    );
  }
  validateFields(msg, fields);
  // The runner is the most exposed parser surface (it executes the
  // received commands), so it gets the strictest validation. Most
  // listed fields on hub→runner messages are string ids/paths/prompts
  // -- empty strings would silently produce broken sessions
  // downstream. Match the pre-#29 runner-side parser which rejected
  // them at the boundary. Non-string fields (`response`, `sessions`)
  // are checked separately below.
  for (const field of fields) {
    if (field === "response" || field === "sessions") continue;
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
  // hub_runner_resync carries an array of {sessionId, sdkSessionId}.
  // Validate shape and reject malformed entries -- runner indexes by
  // sessionId, so an empty/missing id would silently corrupt the map.
  if (msg.type === "hub_runner_resync") {
    if (!Array.isArray(msg.sessions)) {
      throw new MessageValidationError(
        'Invalid hub_runner_resync: "sessions" must be an array',
      );
    }
    for (const entry of msg.sessions as unknown[]) {
      if (
        !isObjectShape(entry) ||
        typeof entry.sessionId !== "string" ||
        entry.sessionId.length === 0 ||
        typeof entry.sdkSessionId !== "string" ||
        entry.sdkSessionId.length === 0
      ) {
        throw new MessageValidationError(
          "Invalid hub_runner_resync: each entry needs non-empty sessionId and sdkSessionId",
        );
      }
    }
  }
  return msg as unknown as HubToRunnerMsg;
}

export function serialize<T extends { type: string }>(msg: T): string {
  return JSON.stringify(msg);
}
