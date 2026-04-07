/**
 * Client→hub message dispatch and the per-message handlers it routes
 * to (start_session, send_prompt, respond_to_prompt, list_*,
 * get_session_history). Connection lifecycle (auth, open, close) lives
 * in hub.ts; this module owns the message-side logic only.
 */
import { randomUUID } from "node:crypto";
import { HUB_METRIC } from "@cc-commander/protocol/metrics";
import type {
  ClientToHubMsg,
  RespondToPromptMsg,
} from "@cc-commander/protocol";
import type { SessionRow } from "../db.ts";
import type { WsContext } from "./context.ts";
import type { ClientConnection, RunnerConnection } from "./types.ts";

/**
 * Validates a directory path supplied by a client. Must be a non-empty
 * absolute POSIX path with no parent-segment traversal (`..`) and no NUL
 * bytes. The runner is still responsible for ensuring the path actually
 * exists and is accessible — this is a defence-in-depth check on the hub.
 */
function isSafeDirectory(dir: unknown): dir is string {
  if (typeof dir !== "string" || dir.length === 0 || dir.length > 4096) {
    return false;
  }
  if (!dir.startsWith("/")) return false;
  if (dir.includes("\0")) return false;
  for (const segment of dir.split("/")) {
    if (segment === "..") return false;
  }
  return true;
}

export function handleClientMessage(
  ctx: WsContext,
  conn: ClientConnection,
  msg: ClientToHubMsg,
): void {
  switch (msg.type) {
    case "list_sessions":
      handleListSessions(ctx, conn);
      break;
    case "list_machines":
      handleListMachines(ctx, conn);
      break;
    case "start_session":
      handleStartSession(ctx, conn, msg);
      break;
    case "send_prompt":
      handleSendPrompt(ctx, conn, msg);
      break;
    case "respond_to_prompt":
      handleRespondToPrompt(ctx, conn, msg);
      break;
    case "get_session_history":
      handleGetSessionHistory(ctx, conn, msg);
      break;
  }
}

export function handleListSessions(
  ctx: WsContext,
  conn: ClientConnection,
): void {
  const sessions = ctx.db.listSessionsForAccount(conn.accountId);
  ctx.sendToClient(conn, { type: "session_list", sessions });
}

export function handleListMachines(
  ctx: WsContext,
  conn: ClientConnection,
): void {
  ctx.sendToClient(conn, {
    type: "machine_list",
    machines: ctx.enrichedMachineList(conn.accountId),
  });
}

function handleStartSession(
  ctx: WsContext,
  conn: ClientConnection,
  msg: { machineId: string; directory: string; prompt: string },
): void {
  if (!isSafeDirectory(msg.directory)) {
    ctx.sendToClient(conn, {
      type: "error",
      message:
        "Invalid directory: must be an absolute path without parent-segment traversal",
    });
    return;
  }
  const runnerConn = ctx.runners.get(msg.machineId);
  if (!runnerConn) {
    ctx.sendToClient(conn, { type: "error", message: "Machine is offline" });
    return;
  }
  if (runnerConn.accountId !== conn.accountId) {
    ctx.sendToClient(conn, { type: "error", message: "Machine not found" });
    return;
  }

  const session = ctx.db.createSession(
    conn.accountId,
    msg.machineId,
    msg.directory,
    "running",
  );

  ctx.sendToRunner(runnerConn, {
    type: "hub_start_session",
    sessionId: session.id,
    directory: msg.directory,
    prompt: msg.prompt,
  });

  ctx.broadcastSessionList(conn.accountId);
}

function handleSendPrompt(
  ctx: WsContext,
  conn: ClientConnection,
  msg: { sessionId: string; prompt: string },
): void {
  const result = resolveSessionRunner(ctx, conn, msg.sessionId);
  if (!result) return;
  ctx.db.updateSessionStatus(result.session.id, "running");
  ctx.sendToRunner(result.runnerConn, {
    type: "hub_send_prompt",
    sessionId: msg.sessionId,
    prompt: msg.prompt,
  });
}

function handleRespondToPrompt(
  ctx: WsContext,
  conn: ClientConnection,
  msg: RespondToPromptMsg,
): void {
  const result = resolveSessionRunner(ctx, conn, msg.sessionId);
  if (!result) return;
  ctx.sendToRunner(result.runnerConn, {
    type: "hub_respond_to_prompt",
    sessionId: msg.sessionId,
    promptId: msg.promptId,
    response: msg.response,
  });
}

function handleGetSessionHistory(
  ctx: WsContext,
  conn: ClientConnection,
  msg: { sessionId: string },
): void {
  const result = resolveSessionRunner(ctx, conn, msg.sessionId);
  if (!result) return;
  const requestId = randomUUID();
  // Bound map growth and unblock the client: a runner that stays
  // connected but never replies (deadlock, dropped message, bug)
  // would otherwise leave the client spinning forever waiting on
  // its requestId. The store fires the onExpire callback exactly
  // once if the TTL elapses before take() is called.
  ctx.pendingHistory.add(
    requestId,
    { conn, machineId: result.runnerConn.machineId },
    (expired) => {
      ctx.metrics.inc(HUB_METRIC.HISTORY_TTL_EXPIRED);
      console.warn(
        `[hub] session_history TTL expired for request ${requestId} on machine ${expired.machineId}`,
      );
      ctx.sendToClient(expired.conn, {
        type: "session_history",
        sessionId: msg.sessionId,
        requestId,
        messages: [],
        error: "timeout",
      });
    },
  );
  ctx.sendToRunner(result.runnerConn, {
    type: "hub_get_history",
    sessionId: msg.sessionId,
    requestId,
  });
}

/** Look up session + verify ownership + find online runner. Sends
 *  error to client and returns null on failure. */
function resolveSessionRunner(
  ctx: WsContext,
  conn: ClientConnection,
  sessionId: string,
): { session: SessionRow; runnerConn: RunnerConnection } | null {
  const session = ctx.db.getSessionById(sessionId);
  if (!session || session.accountId !== conn.accountId) {
    ctx.sendToClient(conn, { type: "error", message: "Session not found" });
    return null;
  }
  const runnerConn = ctx.runners.get(session.machineId);
  if (!runnerConn) {
    ctx.sendToClient(conn, { type: "error", message: "Machine is offline" });
    return null;
  }
  return { session, runnerConn };
}
