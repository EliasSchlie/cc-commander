/**
 * Narrow context the route handlers need from the Hub. Defined as an
 * interface so the routes/ modules don't import the Hub class
 * directly -- avoids the routes ↔ hub circular dep and keeps each
 * handler testable with a hand-rolled fake context.
 *
 * Hub does NOT implement this structurally; instead it builds a small
 * literal context object inside handleHttp that closes over `this`.
 * That keeps Hub's internals private and lets `broadcastMachineList`
 * stay private on the class.
 */
import type { Metrics } from "@cc-commander/protocol/metrics";
import type { Logger } from "@cc-commander/protocol/logger";
import type { AuthService } from "../auth.ts";
import type { HubDb } from "../db.ts";
import type { TokenBucketRateLimiter } from "../rate_limit.ts";

export interface RouteContext {
  auth: AuthService;
  db: HubDb;
  metrics: Metrics;
  /** Per-request loggers are derived from this via .child(). */
  log: Logger;
  loginLimiter: TokenBucketRateLimiter;
  registerLimiter: TokenBucketRateLimiter;
  refreshLimiter: TokenBucketRateLimiter;
  machineCreateLimiter: TokenBucketRateLimiter;
  machineCreateIpLimiter: TokenBucketRateLimiter;
  /** Called after a successful machine create so the Hub can push the
   *  refreshed list to all connected clients on the owning account. */
  broadcastMachineList(accountId: string): void;
  /** Hub's version string from config (empty string if unset). */
  version: string;
  /**
   * Returns a redacted snapshot of hub state for /api/debug/state.
   * Closure (not a Hub reference) so the routes/ layer doesn't pull
   * in hub.ts; the literal carries only counts and ids that already
   * appear in metrics or are derivable from public message flow.
   */
  debugSnapshot(): {
    version: string;
    startedAt: string;
    uptimeSec: number;
    pid: number;
    port: number;
    runners: { count: number; machineIds: string[] };
    clients: { count: number; accounts: number };
    pendingHistory: number;
    memory: NodeJS.MemoryUsage;
    metrics: Record<string, number>;
  };
}
