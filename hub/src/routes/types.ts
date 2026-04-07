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
import type { AuthService } from "../auth.ts";
import type { HubDb } from "../db.ts";
import type { TokenBucketRateLimiter } from "../rate_limit.ts";

export interface RouteContext {
  auth: AuthService;
  db: HubDb;
  metrics: Metrics;
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
}
