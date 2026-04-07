/**
 * /api/health and /api/version handlers. Trivial reads, no auth, no
 * rate limiting -- runners poll /api/version on a tight loop for
 * self-update detection.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { RouteContext } from "./types.ts";

export function handleHealth(
  _ctx: RouteContext,
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200);
  res.end(JSON.stringify({ status: "ok" }));
}

export function handleVersion(
  ctx: RouteContext,
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  res.writeHead(200);
  res.end(JSON.stringify({ version: ctx.version }));
}
