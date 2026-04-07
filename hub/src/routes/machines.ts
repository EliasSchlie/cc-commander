/**
 * /api/machines POST handler. Two-layer rate limit (per-account +
 * per-IP) and a name length cap. Behavior unchanged from when this
 * lived inline on the Hub class.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { HUB_METRIC } from "@cc-commander/protocol/metrics";
import type { JwtPayload } from "../auth.ts";
import { clientIp, extractBearerToken, readBody } from "../util/http.ts";
import type { RouteContext } from "./types.ts";

export const MAX_MACHINE_NAME_LEN = 128;

export async function handleCreateMachine(
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

  // Two-layer check: per-account (existing) catches rapid abuse from
  // a single user; per-IP (new) catches multi-account abuse from one
  // source. Both layers consume independently so the tokens reflect
  // attempts, not survivors -- a wasted token regenerates at the
  // configured rate either way.
  const accountOk = ctx.machineCreateLimiter.tryConsume(payload.accountId);
  const ipOk = ctx.machineCreateIpLimiter.tryConsume(clientIp(req));
  if (!accountOk || !ipOk) {
    // Label which layer rejected so operators can tell single-user
    // abuse from multi-account abuse from one IP. If both layers
    // rejected on the same call, "machine_account" wins (per-account
    // is the user-visible quota and the more specific signal).
    ctx.metrics.inc(HUB_METRIC.RATE_LIMITED, {
      limiter: !accountOk ? "machine_account" : "machine_ip",
    });
    res.writeHead(429);
    res.end(JSON.stringify({ error: "Too many machines created recently" }));
    return;
  }

  let name: string;
  try {
    const body = (await readBody(req)) as { name?: unknown };
    name = typeof body.name === "string" ? body.name.trim() : "";
  } catch (err) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: (err as Error).message }));
    return;
  }
  if (!name) {
    res.writeHead(400);
    res.end(JSON.stringify({ error: "name required" }));
    return;
  }
  if (name.length > MAX_MACHINE_NAME_LEN) {
    res.writeHead(400);
    res.end(
      JSON.stringify({
        error: `name must be ${MAX_MACHINE_NAME_LEN} characters or fewer`,
      }),
    );
    return;
  }

  try {
    const machine = ctx.db.createMachine(payload.accountId, name);
    res.writeHead(201);
    res.end(
      JSON.stringify({
        machineId: machine.id,
        name: machine.name,
        registrationToken: machine.registrationToken,
      }),
    );
    ctx.broadcastMachineList(payload.accountId);
  } catch (err) {
    console.error("[hub] createMachine failed:", err);
    res.writeHead(500);
    res.end(JSON.stringify({ error: "Internal error" }));
  }
}
