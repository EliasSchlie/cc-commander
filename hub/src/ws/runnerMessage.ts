/**
 * Runner→hub message dispatch. Connection lifecycle (auth, open,
 * close, machine eviction) lives in hub.ts; this module owns the
 * message-side logic only.
 */
import { HUB_METRIC } from "@cc-commander/protocol/metrics";
import type { RunnerToHubMsg } from "@cc-commander/protocol";
import type { WsContext } from "./context.ts";
import type { RunnerConnection } from "./types.ts";

export function handleRunnerMessage(
  ctx: WsContext,
  conn: RunnerConnection,
  msg: RunnerToHubMsg,
): void {
  switch (msg.type) {
    case "runner_hello":
      conn.machineName = msg.machineName;
      break;

    case "stream_text":
    case "tool_call":
    case "tool_result":
    case "user_prompt":
      ctx.relayToClients(conn.accountId, msg);
      break;

    case "session_history": {
      // Peek (not take) so a machineId mismatch leaves the entry in
      // the store for the legitimate runner's eventual reply.
      const pending = ctx.pendingHistory.peek(msg.requestId);
      if (!pending) {
        // Either expired (TTL fired) or fabricated by a misbehaving
        // runner. Either way: do not broadcast unsolicited history to
        // every client on the account.
        ctx.metrics.inc(HUB_METRIC.HISTORY_ORPHAN_REPLY);
        ctx.log.warn("dropping session_history with unknown requestId", {
          machineId: conn.machineId,
          requestId: msg.requestId,
          sessionId: msg.sessionId,
        });
        break;
      }
      if (pending.machineId !== conn.machineId) {
        // The runner that replied isn't the one we asked. Drop.
        ctx.metrics.inc(HUB_METRIC.HISTORY_ORPHAN_REPLY);
        ctx.log.warn("session_history reply machineId mismatch", {
          expected: pending.machineId,
          got: conn.machineId,
          requestId: msg.requestId,
        });
        break;
      }
      ctx.pendingHistory.take(msg.requestId);
      if (msg.error) {
        // Operators want degraded-fetch rate as much as orphan rate.
        // The error code is from A1's closed set, so cardinality is
        // bounded by the union (timeout|no_session|fetch_failed).
        ctx.metrics.inc(HUB_METRIC.HISTORY_DEGRADED, { code: msg.error });
      }
      ctx.sendToClient(pending.conn, msg);
      break;
    }

    case "session_status":
      ctx.db.updateSessionStatus(
        msg.sessionId,
        msg.status,
        msg.lastMessagePreview,
      );
      ctx.relayToClients(conn.accountId, msg);
      break;

    case "session_done":
      ctx.db.updateSessionStatus(msg.sessionId, "idle");
      if (msg.sdkSessionId) {
        ctx.db.updateSessionSdkId(msg.sessionId, msg.sdkSessionId);
      }
      ctx.relayToClients(conn.accountId, msg);
      ctx.broadcastSessionList(conn.accountId);
      break;

    case "session_error":
      ctx.db.updateSessionStatus(msg.sessionId, "error", msg.error);
      ctx.relayToClients(conn.accountId, msg);
      ctx.broadcastSessionList(conn.accountId);
      break;

    case "dropped_tool_block":
      // Pure observability signal: SDK shape drift surfaced by the
      // runner-side guards. The labels are closed-set thanks to A1's
      // parser validation, so cardinality is bounded.
      ctx.metrics.inc(HUB_METRIC.DROPPED_TOOL_BLOCK, {
        block_type: msg.blockType,
        reason: msg.reason,
      });
      // ERROR (not warn): SDK shape drift means the runner just failed
      // to forward a real tool exchange to the client. The session will
      // appear to silently skip an action -- exactly the kind of
      // failure that wastes hours when surfaced as a low-priority log.
      ctx.log.error("dropped_tool_block", {
        machineId: conn.machineId,
        sessionId: msg.sessionId,
        blockType: msg.blockType,
        reason: msg.reason,
      });
      break;
  }
}
