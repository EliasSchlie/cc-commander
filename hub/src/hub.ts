import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  parseClientMessage,
  parseRunnerMessage,
  serialize,
} from "@cc-commander/protocol";
import type { HubToRunnerMsg, HubToClientMsg } from "@cc-commander/protocol";
import { HUB_METRIC, Metrics } from "@cc-commander/protocol/metrics";
import { createLogger, type Logger } from "@cc-commander/protocol/logger";
import type { HubDb } from "./db.ts";
import type { AuthService, JwtPayload } from "./auth.ts";
import { TokenBucketRateLimiter } from "./rate_limit.ts";
import { PendingHistoryStore } from "./state/pendingHistory.ts";
import type { ClientConnection, RunnerConnection } from "./ws/types.ts";
import { handleAuthEndpoint, handleRefreshEndpoint } from "./routes/auth.ts";
import { handleCreateMachine } from "./routes/machines.ts";
import { handleHealth, handleVersion } from "./routes/health.ts";
import { handleDebugState } from "./routes/debug.ts";
import type { DebugSnapshot, RouteContext } from "./routes/types.ts";
import { clientIp, extractBearerToken } from "./util/http.ts";
import {
  handleClientMessage,
  handleListMachines,
  handleListSessions,
} from "./ws/clientMessage.ts";
import { handleRunnerMessage } from "./ws/runnerMessage.ts";
import type { WsContext } from "./ws/context.ts";

export interface HubConfig {
  port: number;
  db: HubDb;
  auth: AuthService;
  /**
   * Version string served by GET /api/version. Runners poll this and
   * self-update when their own VERSION differs. Typically set to the git
   * tag at build time (Dockerfile ARG VERSION). Empty string disables
   * the runner self-update protocol (runners will see "" and skip).
   */
  version?: string;
  /**
   * How long to wait for a runner reply to a get_session_history request
   * before giving up, dropping the pending entry, and notifying the client
   * with an empty history. Defaults to 30 seconds. Lower values are useful
   * in tests.
   */
  historyRequestTtlMs?: number;
  /**
   * Override rate limit settings. Defaults are tuned for production
   * (5 logins/min/IP, 3 register/min/IP, 30 refresh/min/IP,
   * 10 machines/hour/account). Tests use higher caps to avoid cross-test
   * pollution.
   */
  rateLimits?: {
    login?: { capacity: number; perMinute: number };
    register?: { capacity: number; perMinute: number };
    refresh?: { capacity: number; perMinute: number };
    machineCreate?: { capacity: number; perHour: number };
    /** Per-IP cap on /api/machines POSTs, layered ON TOP of the per-account
     *  machineCreate limiter so multi-account abuse from one source IP
     *  is bounded. Default 20/hour/IP. */
    machineCreateIp?: { capacity: number; perHour: number };
    /** Per-IP cap on /ws/{client,runner} upgrade attempts. Even rejected
     *  upgrades have non-zero cost (socket alloc, handshake). Default
     *  30/min/IP. */
    wsUpgrade?: { capacity: number; perMinute: number };
  };
  /**
   * Inject a Metrics instance (mostly for tests, which want a fast
   * flush interval and a captured emit). Production callers leave this
   * unset and get the default 60s flush to console.log.
   */
  metrics?: Metrics;
  /**
   * Inject a Logger (mostly for tests, which want to capture log lines
   * for assertions). Production callers leave this unset and get the
   * shared default logger from @cc-commander/protocol/logger.
   */
  logger?: Logger;
  /**
   * ISO8601 timestamp of when the hub was started. Used by
   * /api/debug/state to report uptime; if unset, the Hub stamps its
   * own start time inside the constructor.
   */
  startedAt?: string;
}

export class Hub {
  config: HubConfig;
  clients: Map<string, ClientConnection>;
  /**
   * Secondary index of connections by account, kept in lockstep with
   * `clients`. relayToClients walks ONLY the relevant account's set
   * instead of every connected client, so a stream-text token from
   * one user no longer pays for every other user on the hub.
   */
  private clientsByAccount: Map<string, Set<ClientConnection>>;
  runners: Map<string, RunnerConnection>;
  /** Per-request TTL store for in-flight get_session_history calls. */
  pendingHistory: PendingHistoryStore;
  httpServer: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  loginLimiter: TokenBucketRateLimiter;
  registerLimiter: TokenBucketRateLimiter;
  refreshLimiter: TokenBucketRateLimiter;
  machineCreateLimiter: TokenBucketRateLimiter;
  machineCreateIpLimiter: TokenBucketRateLimiter;
  wsUpgradeLimiter: TokenBucketRateLimiter;
  /**
   * All limiter instances in one place so start/stop sweeping is a
   * single loop. Adding a new limiter only requires registering it
   * here and at the call site, not in three lifecycle methods.
   */
  private limiters: TokenBucketRateLimiter[];
  metrics: Metrics;
  log: Logger;
  readonly startedAt: string;

  constructor(config: HubConfig) {
    this.log = config.logger ?? createLogger("hub");
    this.startedAt = config.startedAt ?? new Date().toISOString();
    this.config = config;
    this.clients = new Map();
    this.clientsByAccount = new Map();
    this.runners = new Map();
    this.pendingHistory = new PendingHistoryStore(
      // Default lives on the store; pass through only if explicitly set.
      config.historyRequestTtlMs,
    );

    const login = config.rateLimits?.login ?? { capacity: 5, perMinute: 5 };
    // Capacity 3 (not 1) so that legitimate users behind shared NAT
    // (corporate, mobile carriers, universities) and users who fat-
    // finger their email/password on first try aren't immediately
    // locked out. Refill is still strict (1/min) so a sustained
    // signup-flood from one IP is bounded.
    const register = config.rateLimits?.register ?? {
      capacity: 3,
      perMinute: 1,
    };
    const refresh = config.rateLimits?.refresh ?? {
      capacity: 30,
      perMinute: 30,
    };
    const machine = config.rateLimits?.machineCreate ?? {
      capacity: 10,
      perHour: 10,
    };
    // 60/hour/IP (not 20) so legitimate users behind shared NAT
    // (corporate, mobile carrier CGNAT, university) aren't immediately
    // false-positived. The per-account layer (10/hour) still bounds
    // single-user abuse; this layer exists to bound multi-account
    // abuse from one source IP.
    const machineIp = config.rateLimits?.machineCreateIp ?? {
      capacity: 60,
      perHour: 60,
    };
    const wsUpgrade = config.rateLimits?.wsUpgrade ?? {
      capacity: 30,
      perMinute: 30,
    };
    this.loginLimiter = new TokenBucketRateLimiter({
      capacity: login.capacity,
      refillPerMs: login.perMinute / 60_000,
    });
    this.registerLimiter = new TokenBucketRateLimiter({
      capacity: register.capacity,
      refillPerMs: register.perMinute / 60_000,
    });
    this.refreshLimiter = new TokenBucketRateLimiter({
      capacity: refresh.capacity,
      refillPerMs: refresh.perMinute / 60_000,
    });
    this.machineCreateLimiter = new TokenBucketRateLimiter({
      capacity: machine.capacity,
      refillPerMs: machine.perHour / 3_600_000,
    });
    this.machineCreateIpLimiter = new TokenBucketRateLimiter({
      capacity: machineIp.capacity,
      refillPerMs: machineIp.perHour / 3_600_000,
    });
    this.wsUpgradeLimiter = new TokenBucketRateLimiter({
      capacity: wsUpgrade.capacity,
      refillPerMs: wsUpgrade.perMinute / 60_000,
    });
    this.limiters = [
      this.loginLimiter,
      this.registerLimiter,
      this.refreshLimiter,
      this.machineCreateLimiter,
      this.machineCreateIpLimiter,
      this.wsUpgradeLimiter,
    ];
    this.metrics = config.metrics ?? new Metrics();

    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({
      server: this.httpServer,
      // Cap a single WebSocket frame. The ws library default is 100 MiB,
      // far above anything the cc-commander protocol can legitimately
      // produce: client/runner envelopes in protocol/src/index.ts are
      // JSON objects of at most a few KB, and the largest variant,
      // session_history, is bounded by the runner to 100 messages
      // (MAX_RESUMABLE_SESSIONS is unrelated; the 100 cap lives on the
      // runner replay path). A single SDK message can still embed a
      // large tool_result (file contents, build output, grep dump), so
      // a 1 MiB cap is too tight in the worst case; 4 MiB leaves
      // headroom for legitimate histories while still bounding memory
      // pressure from a single malicious or buggy frame to a safe
      // fraction of process RSS.
      maxPayload: 4 * 1024 * 1024,
      // Per-IP rate limit BEFORE the upgrade completes. Even rejected
      // upgrades have non-zero cost (socket alloc, handshake, FD), and
      // an attacker can hold half-open sockets to the FD ceiling. The
      // ws library's two-arg verifyClient lets us set the HTTP status
      // so the client (or attacker's botnet) sees a real 429 instead
      // of the default 401.
      verifyClient: (info, cb) => {
        if (!this.wsUpgradeLimiter.tryConsume(clientIp(info.req))) {
          this.metrics.inc(HUB_METRIC.RATE_LIMITED, { limiter: "ws_upgrade" });
          cb(false, 429, "Too Many Requests");
          return;
        }
        cb(true);
      },
    });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
  }

  start(): Promise<void> {
    for (const limiter of this.limiters) limiter.startSweeping();
    this.metrics.start();
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      for (const limiter of this.limiters) limiter.stop();
      this.metrics.stop();
      for (const [, conn] of this.clients) conn.ws.close();
      for (const [, conn] of this.runners) conn.ws.close();
      this.clients.clear();
      this.clientsByAccount.clear();
      this.pendingHistory.clear();
      this.wss.close(() => {
        this.httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    });
  }

  // ── REST API ──────────────────────────────────────────────────────────

  /**
   * Build the route context once per request. Closing over `this` keeps
   * all of Hub's internals private (rate limiters, db, broadcast helper)
   * while routes/ stays decoupled from the Hub class. The literal is
   * cheap; allocating per request avoids any hidden lifetime coupling
   * with stop/restart.
   */
  private routeContext(): RouteContext {
    return {
      auth: this.config.auth,
      db: this.config.db,
      metrics: this.metrics,
      log: this.log,
      loginLimiter: this.loginLimiter,
      registerLimiter: this.registerLimiter,
      refreshLimiter: this.refreshLimiter,
      machineCreateLimiter: this.machineCreateLimiter,
      machineCreateIpLimiter: this.machineCreateIpLimiter,
      broadcastMachineList: (accountId) => this.broadcastMachineList(accountId),
      version: this.config.version ?? "",
      // Debug endpoint reads live state directly off the Hub. Closure
      // (rather than passing the Hub class) keeps routes/ from
      // depending on hub.ts; see RouteContext jsdoc.
      debugSnapshot: (accountId) => this.debugSnapshot(accountId),
    };
  }

  /**
   * Live snapshot of hub state for /api/debug/state. Counts only --
   * never returns auth tokens, registration tokens, account ids, or
   * any per-user content. Designed to be safe to surface to anyone who
   * already has a hub-issued JWT.
   *
   * `runners.machineIds` is filtered to the requesting account so one
   * account can't enumerate every other account's connected machines.
   * Aggregate counts (`runners.count`, `clients.count`,
   * `clients.accounts`) stay global -- they're hub-wide health
   * signals already exposed via metrics.
   */
  debugSnapshot(accountId: string): DebugSnapshot {
    const ownMachineIds: string[] = [];
    for (const conn of this.runners.values()) {
      if (conn.accountId === accountId) ownMachineIds.push(conn.machineId);
    }
    return {
      version: this.config.version ?? "",
      startedAt: this.startedAt,
      uptimeSec: Math.round(process.uptime()),
      pid: process.pid,
      port: this.config.port,
      runners: {
        count: this.runners.size,
        machineIds: ownMachineIds,
      },
      clients: {
        count: this.clients.size,
        accounts: this.clientsByAccount.size,
      },
      pendingHistory: this.pendingHistory.size,
      memory: process.memoryUsage(),
      metrics: this.metrics.snapshot(),
    };
  }

  private async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost:${this.config.port}`);
    res.setHeader("Content-Type", "application/json");
    const ctx = this.routeContext();

    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      return handleAuthEndpoint(ctx, req, res, "register");
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      return handleAuthEndpoint(ctx, req, res, "login");
    }
    if (req.method === "POST" && url.pathname === "/api/auth/refresh") {
      return handleRefreshEndpoint(ctx, req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/machines") {
      return handleCreateMachine(ctx, req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      return handleHealth(ctx, req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/version") {
      return handleVersion(ctx, req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/debug/state") {
      return handleDebugState(ctx, req, res);
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }

  // ── WebSocket ─────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || "/", `http://localhost:${this.config.port}`);

    // When an inbound frame exceeds maxPayload, ws emits an `error`
    // event with a RangeError and then closes the socket with code
    // 1009 (Message Too Big) on its own. Hook it here, before either
    // endpoint-specific handler attaches, so the rejection is logged
    // with the source IP and counted regardless of which path the
    // offender was connecting to. The default `error` handler would
    // otherwise throw uncaughtException on the hub process.
    ws.on("error", (err: Error) => {
      if (err instanceof RangeError) {
        this.metrics.inc(HUB_METRIC.OVERSIZED_FRAME, {
          endpoint: url.pathname === "/ws/runner" ? "runner" : "client",
        });
        this.log.warn("oversized websocket frame rejected", {
          ip: clientIp(req),
          endpoint: url.pathname,
          err: err.message,
        });
      }
    });

    if (url.pathname === "/ws/client") {
      this.handleClientConnection(ws, url, req);
    } else if (url.pathname === "/ws/runner") {
      this.handleRunnerConnection(ws, url);
    } else {
      ws.close(4000, "Unknown endpoint");
    }
  }

  // ── Client connections ────────────────────────────────────────────────

  private handleClientConnection(
    ws: WebSocket,
    url: URL,
    req: IncomingMessage,
  ): void {
    // Prefer Authorization header (no token in logs); fall back to query
    // string for browser clients which can't set headers on WebSocket.
    const token = extractBearerToken(req) ?? url.searchParams.get("token");
    if (!token) {
      ws.close(4001, "Missing token");
      return;
    }

    let payload: JwtPayload;
    try {
      payload = this.config.auth.verifyToken(token);
    } catch {
      ws.close(4001, "Invalid token");
      return;
    }

    const connectionId = randomUUID();
    const conn: ClientConnection = {
      ws,
      accountId: payload.accountId,
      email: payload.email,
    };
    this.addClient(connectionId, conn);
    this.log.info("client connected", {
      connectionId,
      accountId: payload.accountId,
    });

    const wsCtx = this.wsContext();
    handleListSessions(wsCtx, conn);
    handleListMachines(wsCtx, conn);

    ws.on("message", (data) => {
      try {
        const msg = parseClientMessage(data.toString());
        handleClientMessage(this.wsContext(), conn, msg);
      } catch (err) {
        this.metrics.inc(HUB_METRIC.PARSE_REJECT, { source: "client" });
        this.sendToClient(conn, {
          type: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    });

    ws.on("close", () => {
      this.removeClient(connectionId, conn);
      this.pendingHistory.dropMatching((entry) => entry.conn === conn);
      this.log.info("client disconnected", {
        connectionId,
        accountId: payload.accountId,
      });
    });
  }

  private addClient(connectionId: string, conn: ClientConnection): void {
    this.clients.set(connectionId, conn);
    let bucket = this.clientsByAccount.get(conn.accountId);
    if (!bucket) {
      bucket = new Set();
      this.clientsByAccount.set(conn.accountId, bucket);
    }
    bucket.add(conn);
  }

  private removeClient(connectionId: string, conn: ClientConnection): void {
    this.clients.delete(connectionId);
    const bucket = this.clientsByAccount.get(conn.accountId);
    if (!bucket) return;
    bucket.delete(conn);
    // Drop the account bucket entirely once empty so the secondary
    // index doesn't grow forever for one-shot accounts.
    if (bucket.size === 0) this.clientsByAccount.delete(conn.accountId);
  }

  // ── Runner connections ─────────────────────────────────────────────────

  private handleRunnerConnection(ws: WebSocket, url: URL): void {
    const token = url.searchParams.get("token");
    if (!token) {
      ws.close(4001, "Missing registration token");
      return;
    }
    const machine = this.config.db.getMachineByToken(token);
    if (!machine) {
      ws.close(4001, "Invalid registration token");
      return;
    }

    const existing = this.runners.get(machine.id);
    if (existing) {
      existing.ws.close(4002, "Replaced by new connection");
    }

    const conn: RunnerConnection = {
      ws,
      machineId: machine.id,
      accountId: machine.accountId,
      machineName: machine.name,
    };
    this.runners.set(machine.id, conn);
    this.config.db.updateMachineLastSeen(machine.id);
    this.broadcastMachineList(machine.accountId);
    // Replay the resume map to the runner. Without this, a runner
    // restart silently loses session history because the next prompt
    // starts a fresh SDK conversation with no `resume:`. Sent
    // unconditionally -- the runner relies on exactly one resync per
    // connect, even when empty.
    const resumable = this.config.db.listResumableSessionsForMachine(
      machine.id,
    );
    this.sendToRunner(conn, {
      type: "hub_runner_resync",
      sessions: resumable,
    });
    this.log.info("runner connected", {
      machineId: machine.id,
      machineName: machine.name,
      accountId: machine.accountId,
      resyncCount: resumable.length,
    });

    ws.on("message", (data) => {
      try {
        const msg = parseRunnerMessage(data.toString());
        handleRunnerMessage(this.wsContext(), conn, msg);
      } catch (err) {
        this.metrics.inc(HUB_METRIC.PARSE_REJECT, { source: "runner" });
        this.log.error("invalid runner message", {
          machineId: machine.id,
          err: err as Error,
        });
      }
    });

    ws.on("close", () => {
      if (this.runners.get(machine.id)?.ws === ws) {
        this.runners.delete(machine.id);
        // Demote active sessions to idle, not error: the SDK jsonl is
        // intact and the runner will resume them on reconnect via the
        // resync above. Machine offline-ness is surfaced separately
        // through `enrichedMachineList`.
        const affected = this.config.db.markSessionsIdleForMachine(machine.id);
        // Reply will never come from a disconnected runner.
        this.pendingHistory.dropMatching(
          (entry) => entry.machineId === machine.id,
        );
        this.broadcastMachineList(machine.accountId);
        if (affected > 0) {
          this.broadcastSessionList(machine.accountId);
        }
        this.log.info("runner disconnected", {
          machineId: machine.id,
          machineName: machine.name,
          accountId: machine.accountId,
          sessionsIdled: affected,
        });
      }
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────

  /**
   * Build the WebSocket dispatch context. Closing over `this` keeps
   * Hub internals private; the literal is allocated per dispatch but
   * is cheap (8 field references and a handful of bound methods).
   */
  private wsContext(): WsContext {
    return {
      db: this.config.db,
      metrics: this.metrics,
      log: this.log,
      pendingHistory: this.pendingHistory,
      runners: this.runners,
      sendToClient: (conn, msg) => this.sendToClient(conn, msg),
      sendToRunner: (conn, msg) => this.sendToRunner(conn, msg),
      relayToClients: (accountId, msg) => this.relayToClients(accountId, msg),
      broadcastSessionList: (accountId) => this.broadcastSessionList(accountId),
      broadcastMachineList: (accountId) => this.broadcastMachineList(accountId),
      enrichedMachineList: (accountId) => this.enrichedMachineList(accountId),
    };
  }

  private sendToClient(conn: ClientConnection, msg: HubToClientMsg): void {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(serialize(msg));
    }
  }

  private sendToRunner(conn: RunnerConnection, msg: HubToRunnerMsg): void {
    if (conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(serialize(msg));
    }
  }

  private relayToClients(accountId: string, msg: HubToClientMsg): void {
    const bucket = this.clientsByAccount.get(accountId);
    if (!bucket) return;
    for (const conn of bucket) this.sendToClient(conn, msg);
  }

  private broadcastSessionList(accountId: string): void {
    const sessions = this.config.db.listSessionsForAccount(accountId);
    this.relayToClients(accountId, { type: "session_list", sessions });
  }

  private broadcastMachineList(accountId: string): void {
    this.relayToClients(accountId, {
      type: "machine_list",
      machines: this.enrichedMachineList(accountId),
    });
  }

  private enrichedMachineList(
    accountId: string,
  ): import("@cc-commander/protocol").MachineInfo[] {
    return this.config.db
      .listMachinesForAccount(accountId)
      .map((m) => ({ ...m, online: this.runners.has(m.machineId) }));
  }
}
