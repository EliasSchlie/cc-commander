/**
 * POST /api/auth/panic handler. Revokes every refresh token and
 * closes every open client/runner WebSocket owned by the caller's
 * account. Destructive work lives behind `ctx.panicAccount`, a
 * closure over the Hub; this route stays thin so the route layer
 * doesn't have to know about WebSocket internals.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HUB_METRIC } from "@cc-commander/protocol/metrics";
import type { JwtPayload } from "../auth.ts";
import { extractBearerToken } from "../util/http.ts";
import type { RouteContext } from "./types.ts";

export async function handlePanic(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const token = extractBearerToken(req);
  let payload: JwtPayload;
  try {
    if (!token) throw new Error("Unauthorized");
    payload = ctx.auth.verifyToken(token);
  } catch {
    res.writeHead(401);
    res.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }

  if (!ctx.panicLimiter.tryConsume(payload.accountId)) {
    ctx.metrics.inc(HUB_METRIC.RATE_LIMITED, { limiter: "panic" });
    res.writeHead(429);
    res.end(JSON.stringify({ error: "Too many panic requests" }));
    return;
  }

  try {
    ctx.panicAccount(payload.accountId);
    ctx.metrics.inc(HUB_METRIC.PANIC_TRIGGERED);
    res.writeHead(204);
    res.end();
  } catch (err) {
    ctx.log.error("panic failed", {
      accountId: payload.accountId,
      err: err as Error,
    });
    res.writeHead(500);
    res.end(JSON.stringify({ error: "Internal error" }));
  }
}
