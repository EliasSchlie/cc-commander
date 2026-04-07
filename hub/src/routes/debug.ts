/**
 * GET /api/debug/state — authenticated read-only snapshot of hub
 * runtime state. Built so a Claude Code session debugging a deployment
 * can answer "is everything healthy" without parsing logs:
 *
 *   - Hub version, pid, port, uptime, start time
 *   - How many runners are connected (and their machineIds)
 *   - How many client connections, across how many accounts
 *   - Pending history requests in flight
 *   - process.memoryUsage() (heap pressure, RSS)
 *   - All counter snapshots from the Metrics module
 *
 * Auth: requires a valid hub-issued JWT in the Authorization header.
 * Same verification path as /ws/client. Per-account fields
 * (`runners.machineIds`, `recentFailedSessions`) are scoped to the
 * requester's account so one account can't enumerate other accounts'
 * machines or read their failure logs.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { JwtPayload } from "../auth.ts";
import type { RouteContext } from "./types.ts";
import { extractBearerToken } from "../util/http.ts";

export function handleDebugState(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): void {
  const token = extractBearerToken(req);
  if (!token) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Missing token" }));
    return;
  }
  let payload: JwtPayload;
  try {
    payload = ctx.auth.verifyToken(token);
  } catch {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Invalid token" }));
    return;
  }

  const snapshot = ctx.debugSnapshot(payload.accountId);

  // Per-account post-mortem slice. Limited to the requester's
  // account so /api/debug/state can return failed sessions without
  // leaking other accounts' directories or error messages.
  const recentFailedSessions = ctx.db
    .listFailedSessionsForAccount(payload.accountId, 25)
    .map((s) => ({
      sessionId: s.id,
      machineId: s.machineId,
      directory: s.directory,
      errorMessage: s.errorMessage,
      endedAt: s.endedAt,
      createdAt: s.createdAt,
    }));

  res.writeHead(200);
  res.end(JSON.stringify({ ...snapshot, recentFailedSessions }));
}
