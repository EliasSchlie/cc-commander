/**
 * `hub status` subcommand. Hits a running hub's HTTP endpoints and
 * prints a one-screen summary so an operator (or a Claude Code session
 * debugging the deployment) can answer "is it up, what version, when
 * did it start" without parsing logs.
 *
 * Designed to be safe to run against any reachable hub URL -- it only
 * makes GET requests against the unauthenticated /api/health and
 * /api/version endpoints. /api/debug/state is attempted only if a JWT
 * is supplied via $HUB_DEBUG_TOKEN; this keeps the command useful in
 * the common case (smoke check from CI) without leaking auth
 * requirements into the basic flow.
 */
import type { Logger } from "@cc-commander/protocol/logger";

interface JsonResponse {
  status: number;
  data: unknown;
}

async function getJson(
  url: string,
  headers: Record<string, string> = {},
): Promise<JsonResponse> {
  const res = await fetch(url, { headers });
  let data: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: res.status, data };
}

export async function runHubStatus(
  baseUrl: string,
  log: Logger,
): Promise<void> {
  const trimmed = baseUrl.replace(/\/$/, "");
  log.info("hub status check", { baseUrl: trimmed });

  let healthy = false;
  try {
    const res = await getJson(`${trimmed}/api/health`);
    healthy = res.status === 200;
    log.info("health", { status: res.status, body: res.data });
  } catch (err) {
    log.error("health check failed", { err: err as Error });
  }

  try {
    const res = await getJson(`${trimmed}/api/version`);
    log.info("version", { status: res.status, body: res.data });
  } catch (err) {
    log.error("version check failed", { err: err as Error });
  }

  const debugToken = process.env.HUB_DEBUG_TOKEN;
  if (debugToken) {
    try {
      const res = await getJson(`${trimmed}/api/debug/state`, {
        Authorization: `Bearer ${debugToken}`,
      });
      log.info("debug state", { status: res.status, body: res.data });
    } catch (err) {
      log.error("debug state fetch failed", { err: err as Error });
    }
  } else {
    log.info("debug state skipped", {
      hint: "set HUB_DEBUG_TOKEN to a valid JWT to fetch /api/debug/state",
    });
  }

  if (!healthy) {
    log.warn("hub is NOT healthy", { baseUrl: trimmed });
  }
}
