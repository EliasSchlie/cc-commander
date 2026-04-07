import { WebSocketServer, WebSocket } from "ws";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { URL } from "node:url";
import { randomUUID } from "node:crypto";
import {
  parseClientMessage,
  parseRunnerMessage,
  serialize,
} from "./protocol.ts";
import type {
  ClientToHubMsg,
  RunnerToHubMsg,
  HubToRunnerMsg,
  HubToClientMsg,
  RespondToPromptMsg,
} from "./protocol.ts";
import type { HubDb } from "./db.ts";
import type { AuthService, JwtPayload } from "./auth.ts";
import { DuplicateEmailError } from "./auth.ts";
import { TokenBucketRateLimiter } from "./rate_limit.ts";

interface ClientConnection {
  ws: WebSocket;
  accountId: string;
  email: string;
}

interface RunnerConnection {
  ws: WebSocket;
  machineId: string;
  accountId: string;
  machineName: string;
}

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
   * Override rate limit settings. Defaults are tuned for production
   * (5 logins/min/IP, 1 register/min/IP, 10 machines/hour/account).
   * Tests use higher caps to avoid cross-test pollution.
   */
  rateLimits?: {
    login?: { capacity: number; perMinute: number };
    register?: { capacity: number; perMinute: number };
    refresh?: { capacity: number; perMinute: number };
    machineCreate?: { capacity: number; perHour: number };
  };
}

export class Hub {
  config: HubConfig;
  clients: Map<string, ClientConnection>;
  runners: Map<string, RunnerConnection>;
  /** Maps requestId -> { client that asked, machineId the request was sent to, expiry timer } */
  pendingHistoryRequests: Map<
    string,
    {
      conn: ClientConnection;
      machineId: string;
      timer: ReturnType<typeof setTimeout>;
    }
  >;
  httpServer: ReturnType<typeof createServer>;
  wss: WebSocketServer;
  loginLimiter: TokenBucketRateLimiter;
  registerLimiter: TokenBucketRateLimiter;
  refreshLimiter: TokenBucketRateLimiter;
  machineCreateLimiter: TokenBucketRateLimiter;

  constructor(config: HubConfig) {
    this.config = config;
    this.clients = new Map();
    this.runners = new Map();
    this.pendingHistoryRequests = new Map();

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

    this.httpServer = createServer((req, res) => this.handleHttp(req, res));
    this.wss = new WebSocketServer({ server: this.httpServer });
    this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
  }

  start(): Promise<void> {
    this.loginLimiter.startSweeping();
    this.registerLimiter.startSweeping();
    this.refreshLimiter.startSweeping();
    this.machineCreateLimiter.startSweeping();
    return new Promise((resolve) => {
      this.httpServer.listen(this.config.port, () => resolve());
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.loginLimiter.stop();
      this.registerLimiter.stop();
      this.refreshLimiter.stop();
      this.machineCreateLimiter.stop();
      for (const [, conn] of this.clients) conn.ws.close();
      for (const [, conn] of this.runners) conn.ws.close();
      for (const [, entry] of this.pendingHistoryRequests) {
        clearTimeout(entry.timer);
      }
      this.pendingHistoryRequests.clear();
      this.wss.close(() => {
        this.httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    });
  }

  // ── REST API ──────────────────────────────────────────────────────────

  private async handleHttp(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost:${this.config.port}`);

    res.setHeader("Content-Type", "application/json");

    if (req.method === "POST" && url.pathname === "/api/auth/register") {
      return this.handleAuthEndpoint(req, res, "register");
    }
    if (req.method === "POST" && url.pathname === "/api/auth/login") {
      return this.handleAuthEndpoint(req, res, "login");
    }
    if (req.method === "POST" && url.pathname === "/api/auth/refresh") {
      return this.handleRefreshEndpoint(req, res);
    }
    if (req.method === "POST" && url.pathname === "/api/machines") {
      return this.handleCreateMachine(req, res);
    }
    if (req.method === "GET" && url.pathname === "/api/health") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/version") {
      res.writeHead(200);
      res.end(JSON.stringify({ version: this.config.version ?? "" }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async handleAuthEndpoint(
    req: IncomingMessage,
    res: ServerResponse,
    action: "register" | "login",
  ): Promise<void> {
    const ip = clientIp(req);
    const limiter =
      action === "register" ? this.registerLimiter : this.loginLimiter;
    if (!limiter.tryConsume(ip)) {
      res.writeHead(429);
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }
    try {
      const body = await readBody(req);
      const { email, password } = body;
      if (!email || !password) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "email and password required" }));
        return;
      }
      const tokens =
        action === "register"
          ? await this.config.auth.register(email, password)
          : await this.config.auth.login(email, password);
      res.writeHead(200);
      res.end(JSON.stringify(tokens));
    } catch (err) {
      const isConflict =
        action === "register" && err instanceof DuplicateEmailError;
      res.writeHead(isConflict ? 409 : 401);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleRefreshEndpoint(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    if (!this.refreshLimiter.tryConsume(clientIp(req))) {
      res.writeHead(429);
      res.end(JSON.stringify({ error: "Too many requests" }));
      return;
    }
    try {
      const body = await readBody(req);
      if (!body.refreshToken) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "refreshToken required" }));
        return;
      }
      const tokens = await this.config.auth.refresh(body.refreshToken);
      res.writeHead(200);
      res.end(JSON.stringify(tokens));
    } catch (err) {
      res.writeHead(401);
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
  }

  private async handleCreateMachine(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const token = extractBearerToken(req);
    let payload: JwtPayload;
    try {
      if (!token) throw new Error("Unauthorized");
      payload = this.config.auth.verifyToken(token);
    } catch {
      res.writeHead(401);
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (!this.machineCreateLimiter.tryConsume(payload.accountId)) {
      res.writeHead(429);
      res.end(JSON.stringify({ error: "Too many machines created recently" }));
      return;
    }

    let name: string;
    try {
      const body = await readBody(req);
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
      const machine = this.config.db.createMachine(payload.accountId, name);
      res.writeHead(201);
      res.end(
        JSON.stringify({
          machineId: machine.id,
          name: machine.name,
          registrationToken: machine.registrationToken,
        }),
      );
      this.broadcastMachineList(payload.accountId);
    } catch (err) {
      console.error("[hub] createMachine failed:", err);
      res.writeHead(500);
      res.end(JSON.stringify({ error: "Internal error" }));
    }
  }

  /** Removes pending history request entries matching the predicate. Cancels their TTL timers. */
  private dropPendingHistoryFor(
    predicate: (entry: {
      conn: ClientConnection;
      machineId: string;
    }) => boolean,
  ): void {
    if (this.pendingHistoryRequests.size === 0) return;
    for (const [requestId, entry] of this.pendingHistoryRequests) {
      if (predicate(entry)) {
        clearTimeout(entry.timer);
        this.pendingHistoryRequests.delete(requestId);
      }
    }
  }

  private deletePendingHistory(requestId: string): void {
    const entry = this.pendingHistoryRequests.get(requestId);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.pendingHistoryRequests.delete(requestId);
  }

  // ── WebSocket ─────────────────────────────────────────────────────────

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    const url = new URL(req.url || "/", `http://localhost:${this.config.port}`);

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
    this.clients.set(connectionId, conn);

    this.handleListSessions(conn);
    this.handleListMachines(conn);

    ws.on("message", (data) => {
      try {
        const msg = parseClientMessage(data.toString());
        this.handleClientMessage(conn, msg);
      } catch (err) {
        this.sendToClient(conn, {
          type: "error",
          message: err instanceof Error ? err.message : "Unknown error",
        });
      }
    });

    ws.on("close", () => {
      this.clients.delete(connectionId);
      this.dropPendingHistoryFor((entry) => entry.conn === conn);
    });
  }

  private handleClientMessage(
    conn: ClientConnection,
    msg: ClientToHubMsg,
  ): void {
    switch (msg.type) {
      case "list_sessions":
        this.handleListSessions(conn);
        break;
      case "list_machines":
        this.handleListMachines(conn);
        break;
      case "start_session":
        this.handleStartSession(conn, msg);
        break;
      case "send_prompt":
        this.handleSendPrompt(conn, msg);
        break;
      case "respond_to_prompt":
        this.handleRespondToPrompt(conn, msg);
        break;
      case "get_session_history":
        this.handleGetSessionHistory(conn, msg);
        break;
    }
  }

  private handleListSessions(conn: ClientConnection): void {
    const sessions = this.config.db.listSessionsForAccount(conn.accountId);
    this.sendToClient(conn, { type: "session_list", sessions });
  }

  private handleListMachines(conn: ClientConnection): void {
    this.sendToClient(conn, {
      type: "machine_list",
      machines: this.enrichedMachineList(conn.accountId),
    });
  }

  private handleStartSession(
    conn: ClientConnection,
    msg: { machineId: string; directory: string; prompt: string },
  ): void {
    if (!isSafeDirectory(msg.directory)) {
      this.sendToClient(conn, {
        type: "error",
        message:
          "Invalid directory: must be an absolute path without parent-segment traversal",
      });
      return;
    }
    const runnerConn = this.runners.get(msg.machineId);
    if (!runnerConn) {
      this.sendToClient(conn, { type: "error", message: "Machine is offline" });
      return;
    }
    if (runnerConn.accountId !== conn.accountId) {
      this.sendToClient(conn, { type: "error", message: "Machine not found" });
      return;
    }

    const session = this.config.db.createSession(
      conn.accountId,
      msg.machineId,
      msg.directory,
      "running",
    );

    this.sendToRunner(runnerConn, {
      type: "hub_start_session",
      sessionId: session.id,
      directory: msg.directory,
      prompt: msg.prompt,
    });

    this.broadcastSessionList(conn.accountId);
  }

  private handleSendPrompt(
    conn: ClientConnection,
    msg: { sessionId: string; prompt: string },
  ): void {
    const result = this.resolveSessionRunner(conn, msg.sessionId);
    if (!result) return;
    this.config.db.updateSessionStatus(result.session.id, "running");
    this.sendToRunner(result.runnerConn, {
      type: "hub_send_prompt",
      sessionId: msg.sessionId,
      prompt: msg.prompt,
    });
  }

  private handleRespondToPrompt(
    conn: ClientConnection,
    msg: RespondToPromptMsg,
  ): void {
    const result = this.resolveSessionRunner(conn, msg.sessionId);
    if (!result) return;
    this.sendToRunner(result.runnerConn, {
      type: "hub_respond_to_prompt",
      sessionId: msg.sessionId,
      promptId: msg.promptId,
      response: msg.response,
    });
  }

  private handleGetSessionHistory(
    conn: ClientConnection,
    msg: { sessionId: string },
  ): void {
    const result = this.resolveSessionRunner(conn, msg.sessionId);
    if (!result) return;
    const requestId = randomUUID();
    // Bound map growth: a misbehaving or hung runner must not be able to
    // pin pending entries indefinitely.
    const timer = setTimeout(() => {
      this.pendingHistoryRequests.delete(requestId);
    }, PENDING_HISTORY_TTL_MS);
    timer.unref();
    this.pendingHistoryRequests.set(requestId, {
      conn,
      machineId: result.runnerConn.machineId,
      timer,
    });
    this.sendToRunner(result.runnerConn, {
      type: "hub_get_history",
      sessionId: msg.sessionId,
      requestId,
    });
  }

  /** Look up session + verify ownership + find online runner. Sends error to client and returns null on failure. */
  private resolveSessionRunner(
    conn: ClientConnection,
    sessionId: string,
  ): {
    session: import("./db.ts").SessionRow;
    runnerConn: RunnerConnection;
  } | null {
    const session = this.config.db.getSessionById(sessionId);
    if (!session || session.accountId !== conn.accountId) {
      this.sendToClient(conn, { type: "error", message: "Session not found" });
      return null;
    }
    const runnerConn = this.runners.get(session.machineId);
    if (!runnerConn) {
      this.sendToClient(conn, { type: "error", message: "Machine is offline" });
      return null;
    }
    return { session, runnerConn };
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

    ws.on("message", (data) => {
      try {
        const msg = parseRunnerMessage(data.toString());
        this.handleRunnerMessage(conn, msg);
      } catch (err) {
        console.error("Invalid runner message:", err);
      }
    });

    ws.on("close", () => {
      if (this.runners.get(machine.id)?.ws === ws) {
        this.runners.delete(machine.id);
        const affected = this.config.db.markSessionsErrorForMachine(
          machine.id,
          "Runner disconnected",
        );
        // Reply will never come from a disconnected runner.
        this.dropPendingHistoryFor((entry) => entry.machineId === machine.id);
        this.broadcastMachineList(machine.accountId);
        if (affected > 0) {
          this.broadcastSessionList(machine.accountId);
        }
      }
    });
  }

  private handleRunnerMessage(
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
        this.relayToClients(conn.accountId, msg);
        break;

      case "session_history": {
        const pending = this.pendingHistoryRequests.get(msg.requestId);
        if (!pending) {
          // Either expired (TTL fired) or fabricated by a misbehaving
          // runner. Either way: do not broadcast unsolicited history to
          // every client on the account.
          console.warn(
            `[hub] dropping session_history with unknown requestId from machine ${conn.machineId}`,
          );
          break;
        }
        if (pending.machineId !== conn.machineId) {
          // The runner that replied isn't the one we asked. Drop.
          console.warn(
            `[hub] session_history reply machineId mismatch (expected ${pending.machineId}, got ${conn.machineId})`,
          );
          break;
        }
        this.deletePendingHistory(msg.requestId);
        this.sendToClient(pending.conn, msg);
        break;
      }

      case "session_status":
        this.config.db.updateSessionStatus(
          msg.sessionId,
          msg.status,
          msg.lastMessagePreview,
        );
        this.relayToClients(conn.accountId, msg);
        break;

      case "session_done":
        this.config.db.updateSessionStatus(msg.sessionId, "idle");
        if (msg.sdkSessionId) {
          this.config.db.updateSessionSdkId(msg.sessionId, msg.sdkSessionId);
        }
        this.relayToClients(conn.accountId, msg);
        this.broadcastSessionList(conn.accountId);
        break;

      case "session_error":
        this.config.db.updateSessionStatus(msg.sessionId, "error", msg.error);
        this.relayToClients(conn.accountId, msg);
        this.broadcastSessionList(conn.accountId);
        break;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────

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
    for (const [, conn] of this.clients) {
      if (conn.accountId === accountId) {
        this.sendToClient(conn, msg);
      }
    }
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
  ): import("./protocol.ts").MachineInfo[] {
    const machines = this.config.db.listMachinesForAccount(accountId);
    for (const m of machines) m.online = this.runners.has(m.machineId);
    return machines;
  }
}

const BEARER_PREFIX = "Bearer ";

/**
 * Best-effort client IP. Falls back to "unknown" so a missing socket
 * address still ends up rate-limited (under one shared bucket) instead
 * of bypassing the limiter entirely. Does NOT trust X-Forwarded-For:
 * the hub currently has no proxy-trust config, and trusting that header
 * unconditionally would let any caller spoof their bucket key.
 */
function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? "unknown";
}

function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return header.slice(BEARER_PREFIX.length);
}

const MAX_BODY_BYTES = 1024 * 1024; // 1MB
const MAX_MACHINE_NAME_LEN = 128;
const PENDING_HISTORY_TTL_MS = 30_000;

/**
 * Validates a directory path supplied by a client. Must be a non-empty
 * absolute POSIX path with no parent-segment traversal (`..`) and no NUL
 * bytes. The runner is still responsible for ensuring the path actually
 * exists and is accessible — this is a defence-in-depth check on the hub.
 */
function isSafeDirectory(dir: unknown): dir is string {
  if (typeof dir !== "string" || dir.length === 0 || dir.length > 4096) {
    return false;
  }
  if (!dir.startsWith("/")) return false;
  if (dir.includes("\0")) return false;
  for (const segment of dir.split("/")) {
    if (segment === "..") return false;
  }
  return true;
}

function readBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.byteLength;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}
