/**
 * /api/auth/{register,login,refresh} handlers. Pure module-level
 * functions taking a narrow RouteContext so each handler is testable
 * with a hand-rolled fake. Behavior is unchanged from when this lived
 * inline on the Hub class.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HUB_METRIC } from "@cc-commander/protocol/metrics";
import { DuplicateEmailError } from "../auth.ts";
import { clientIp, readBody } from "../util/http.ts";
import type { RouteContext } from "./types.ts";

export async function handleAuthEndpoint(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
  action: "register" | "login",
): Promise<void> {
  const ip = clientIp(req);
  const limiter =
    action === "register" ? ctx.registerLimiter : ctx.loginLimiter;
  if (!limiter.tryConsume(ip)) {
    ctx.metrics.inc(HUB_METRIC.RATE_LIMITED, { limiter: action });
    res.writeHead(429);
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }
  try {
    const body = (await readBody(req)) as {
      email?: unknown;
      password?: unknown;
    };
    const { email, password } = body;
    // Match the prior `!email || !password` semantics: reject empty
    // strings, null, undefined, and any non-string type.
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      email.length === 0 ||
      password.length === 0
    ) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "email and password required" }));
      return;
    }
    const tokens =
      action === "register"
        ? await ctx.auth.register(email, password)
        : await ctx.auth.login(email, password);
    res.writeHead(200);
    res.end(JSON.stringify(tokens));
  } catch (err) {
    const isConflict =
      action === "register" && err instanceof DuplicateEmailError;
    res.writeHead(isConflict ? 409 : 401);
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}

export async function handleRefreshEndpoint(
  ctx: RouteContext,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (!ctx.refreshLimiter.tryConsume(clientIp(req))) {
    ctx.metrics.inc(HUB_METRIC.RATE_LIMITED, { limiter: "refresh" });
    res.writeHead(429);
    res.end(JSON.stringify({ error: "Too many requests" }));
    return;
  }
  try {
    const body = (await readBody(req)) as { refreshToken?: unknown };
    if (
      typeof body.refreshToken !== "string" ||
      body.refreshToken.length === 0
    ) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "refreshToken required" }));
      return;
    }
    const tokens = await ctx.auth.refresh(body.refreshToken);
    res.writeHead(200);
    res.end(JSON.stringify(tokens));
  } catch (err) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: (err as Error).message }));
  }
}
