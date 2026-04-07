import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WebSocket } from "ws";
import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { parseHubMessage, serialize } from "@cc-commander/protocol";
import { Metrics, RUNNER_METRIC } from "@cc-commander/protocol/metrics";
import { createLogger, type Logger } from "@cc-commander/protocol/logger";
import type {
  DroppedToolBlockMsg,
  HubToRunnerMsg,
  RunnerToHubMsg,
  UserPromptResponse,
} from "@cc-commander/protocol";

type DroppedToolBlockPayload = Omit<DroppedToolBlockMsg, "type" | "sessionId">;

const ASK_USER_TOOL = "AskUserQuestion";
const MAX_SDK_SESSION_IDS = 1000;

interface ActiveSession {
  sessionId: string;
  sdkSessionId: string | null;
  abortController: AbortController;
  pendingPrompts: Map<string, (response: UserPromptResponse) => void>;
}

type CanUseToolResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string };

interface QueryOptions {
  maxTurns: number;
  permissionMode: "bypassPermissions";
  allowDangerouslySkipPermissions: boolean;
  includePartialMessages: boolean;
  abortController: AbortController;
  canUseTool: (
    toolName: string,
    input: Record<string, unknown>,
    opts: { title?: string },
  ) => Promise<CanUseToolResult>;
  cwd?: string;
  resume?: string;
}

export type QueryFn = typeof query;
export type GetSessionMessagesFn = typeof getSessionMessages;

export interface RunnerConfig {
  hubUrl: string;
  registrationToken: string;
  machineName: string;
  reconnectIntervalMs?: number;
  queryFn?: QueryFn;
  getSessionMessagesFn?: GetSessionMessagesFn;
  /** Inject a Metrics instance (mostly for tests). */
  metrics?: Metrics;
  /** Inject a Logger (mostly for tests). */
  logger?: Logger;
}

export class MachineRunner {
  config: RunnerConfig;
  ws: WebSocket | null;
  sessions: Map<string, ActiveSession>;
  sdkSessionIds: Map<string, string>;
  shouldReconnect: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  queryFn: QueryFn;
  getSessionMessagesFn: GetSessionMessagesFn;
  metrics: Metrics;
  log: Logger;

  constructor(config: RunnerConfig) {
    this.config = config;
    this.ws = null;
    this.sessions = new Map();
    this.sdkSessionIds = new Map();
    this.shouldReconnect = true;
    this.reconnectTimer = null;
    this.queryFn = config.queryFn || query;
    this.getSessionMessagesFn =
      config.getSessionMessagesFn || getSessionMessages;
    this.metrics = config.metrics ?? new Metrics();
    this.log =
      config.logger ??
      createLogger("runner", { machineName: config.machineName });
  }

  connect(): Promise<void> {
    // Idempotent: reconnect re-enters connect() and start() is a no-op
    // when the timer is already running, so counters keep flowing across
    // reconnect storms without losing the running totals.
    this.metrics.start();
    return new Promise((resolve, reject) => {
      const url = `${this.config.hubUrl}/ws/runner?token=${this.config.registrationToken}`;
      this.ws = new WebSocket(url);
      let connected = false;

      this.ws.on("open", () => {
        connected = true;
        this.log.info("connected to hub");
        this.sendToHub({
          type: "runner_hello",
          machineName: this.config.machineName,
        });
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const msg = parseHubMessage(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          this.metrics.inc(RUNNER_METRIC.PARSE_REJECT);
          this.log.error("invalid message from hub", { err: err as Error });
        }
      });

      this.ws.on("close", () => {
        // Always log -- silent disconnects were one of the worst
        // debugging gaps. Tag with whether we had ever connected
        // (initial-connect failure vs mid-session drop) so an
        // operator can tell them apart at a glance.
        this.log.warn("disconnected from hub", {
          everConnected: connected,
          willReconnect: connected && this.shouldReconnect,
        });
        if (connected && this.shouldReconnect) {
          const delay = this.config.reconnectIntervalMs ?? 5000;
          this.log.info("scheduling reconnect", { delayMs: delay });
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch((e) =>
              this.log.error("reconnect failed", { err: e as Error }),
            );
          }, delay);
        }
      });

      this.ws.on("error", (err) => {
        this.log.error("WebSocket error", { message: err.message });
        if (!connected) reject(err);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this.metrics.stop();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, session] of this.sessions) {
      session.abortController.abort();
      rejectPendingPrompts(session, "Runner disconnected");
    }
    this.sessions.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private sendToHub(msg: RunnerToHubMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serialize(msg));
    }
  }

  private handleMessage(msg: HubToRunnerMsg): void {
    const sessionId = "sessionId" in msg ? (msg as any).sessionId : undefined;
    this.log.debug("handle hub message", { msgType: msg.type, sessionId });
    switch (msg.type) {
      case "hub_start_session":
        this.runSession(msg.sessionId, msg.prompt, { cwd: msg.directory });
        break;
      case "hub_send_prompt":
        this.handleSendPrompt(msg.sessionId, msg.prompt);
        break;
      case "hub_respond_to_prompt":
        this.resolvePrompt(msg.sessionId, msg.promptId, msg.response);
        break;
      case "hub_get_history":
        this.getHistory(msg.sessionId, msg.requestId);
        break;
      case "hub_runner_resync":
        this.handleResync(msg.sessions);
        break;
      default:
        this.log.warn("unhandled hub message type", {
          msgType: (msg as any).type,
        });
    }
  }

  /**
   * Repopulate the in-memory `sessionId → sdkSessionId` map from the
   * hub on (re)connect. The runner has no on-disk state of its own;
   * on a process restart this map vanishes, and without resync the
   * next `hub_send_prompt` for an existing session would resolve
   * `sdkSessionId` to undefined and start a fresh SDK conversation
   * with no `resume:` -- losing all history. The hub knows the
   * mapping (it's in the DB) and pushes it here.
   *
   * Replaces the existing map outright: the hub's view is canonical,
   * any stale entries from before reconnect should be dropped. The
   * hub already caps the list, but we enforce MAX_SDK_SESSION_IDS
   * defensively here in case the bound drifts.
   */
  private handleResync(
    sessions: ReadonlyArray<{ sessionId: string; sdkSessionId: string }>,
  ): void {
    this.sdkSessionIds = new Map();
    const capped = sessions.slice(0, MAX_SDK_SESSION_IDS);
    for (const { sessionId, sdkSessionId } of capped) {
      this.sdkSessionIds.set(sessionId, sdkSessionId);
    }
    this.log.info("runner resync applied", {
      received: sessions.length,
      applied: capped.length,
    });
  }

  private resolveSdkSessionId(sessionId: string): string | undefined {
    return (
      this.sessions.get(sessionId)?.sdkSessionId ||
      this.sdkSessionIds.get(sessionId) ||
      undefined
    );
  }

  // ── Session runner ────────────────────────────────────────────────────

  private async runSession(
    sessionId: string,
    prompt: string,
    extra: { cwd?: string; resume?: string },
  ): Promise<void> {
    // SDK chdir failures surface as "Claude Code executable not found
    // at .../cli.js" -- catch the bad cwd here so the user sees the
    // real cause. Done before touching `this.sessions` so a bad-cwd
    // retry doesn't kill the previously running session for the same
    // id and doesn't flap the session through running→error.
    if (extra.cwd !== undefined) {
      const cwdError = validateCwd(extra.cwd);
      if (cwdError) {
        this.log.warn("rejecting bad cwd", {
          sessionId,
          cwd: extra.cwd,
          reason: cwdError,
        });
        this.sendToHub({
          type: "session_error",
          sessionId,
          error: cwdError,
        });
        return;
      }
    }

    const existing = this.sessions.get(sessionId);
    if (existing) {
      existing.abortController.abort();
      // Unblock canUseTool of the aborted session; the replacement gets
      // a fresh pendingPrompts map below.
      rejectPendingPrompts(existing, "Session restarted");
    }

    const abortController = new AbortController();
    const session: ActiveSession = {
      sessionId,
      sdkSessionId: extra.resume || this.resolveSdkSessionId(sessionId) || null,
      abortController,
      pendingPrompts: new Map(),
    };
    this.sessions.set(sessionId, session);
    this.sendToHub({ type: "session_status", sessionId, status: "running" });
    // Per-session child logger so a single grep on `sessionId=<id>`
    // reconstructs the full request trace across hub→runner→SDK
    // boundaries. Cheap (one extra Map allocation per session start).
    const slog = this.log.child({ sessionId });
    slog.info("session start", {
      cwd: extra.cwd ?? null,
      resume: extra.resume ?? null,
      promptLen: prompt.length,
    });

    let promptCounter = 0;
    let streamCount = 0;

    try {
      const options: QueryOptions = {
        maxTurns: 50,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController,
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          opts: { title?: string },
        ) => {
          return this.handleCanUseTool(
            session,
            `${sessionId}-${++promptCounter}`,
            toolName,
            input,
            opts,
          );
        },
      };
      if (extra.cwd) options.cwd = extra.cwd;
      if (extra.resume) options.resume = extra.resume;

      slog.debug("invoking SDK query()");
      for await (const msg of this.queryFn({ prompt, options })) {
        streamCount++;
        if (streamCount <= 5 || streamCount % 20 === 0) {
          slog.debug("sdk message", {
            seq: streamCount,
            msgType: (msg as any).type,
          });
        }
        this.processStreamMessage(msg, session);
      }
      slog.info("session complete", { streamCount });
    } catch (err) {
      slog.error("session threw", {
        streamCount,
        err: err as Error,
      });
      if (!abortController.signal.aborted) {
        this.sendToHub({
          type: "session_error",
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      slog.debug("session cleanup", { sdkSessionId: session.sdkSessionId });
      if (session.sdkSessionId) {
        // Evict oldest entry if at capacity
        if (this.sdkSessionIds.size >= MAX_SDK_SESSION_IDS) {
          const oldest = this.sdkSessionIds.keys().next().value;
          if (oldest !== undefined) this.sdkSessionIds.delete(oldest);
        }
        this.sdkSessionIds.set(sessionId, session.sdkSessionId);
      }
      // Only delete if we're still the active session for this id. A
      // concurrent restart may have already replaced the entry; deleting
      // unconditionally would orphan the new run.
      if (this.sessions.get(sessionId) === session) {
        this.sessions.delete(sessionId);
      }
    }
  }

  private handleSendPrompt(sessionId: string, prompt: string): void {
    const sdkSessionId = this.resolveSdkSessionId(sessionId);
    this.runSession(
      sessionId,
      prompt,
      sdkSessionId ? { resume: sdkSessionId } : {},
    );
  }

  // ── canUseTool ────────────────────────────────────────────────────────

  private async handleCanUseTool(
    session: ActiveSession,
    promptId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: { title?: string },
  ): Promise<CanUseToolResult> {
    const { sessionId } = session;

    if (toolName === ASK_USER_TOOL) {
      const questions = (input as any).questions || [];
      this.sendToHub({
        type: "user_prompt",
        sessionId,
        promptId,
        toolName,
        questions: questions.map((q: any) => ({
          question: q.question,
          header: q.header,
          options: q.options || [],
          multiSelect: !!q.multiSelect,
        })),
      });
      this.sendToHub({
        type: "session_status",
        sessionId,
        status: "waiting_for_input",
        lastMessagePreview: questions[0]?.question || "Waiting for input",
      });
      const response = await this.waitForPromptResponse(session, promptId);
      this.sendToHub({ type: "session_status", sessionId, status: "running" });

      if (response.kind === "answers") {
        return {
          behavior: "allow",
          updatedInput: {
            questions: (input as any).questions,
            answers: response.answers,
          },
        };
      }
      return { behavior: "deny", message: "User cancelled" };
    }

    this.sendToHub({
      type: "user_prompt",
      sessionId,
      promptId,
      toolName,
      title: opts.title,
      input,
    });
    this.sendToHub({
      type: "session_status",
      sessionId,
      status: "waiting_for_input",
    });
    const response = await this.waitForPromptResponse(session, promptId);
    this.sendToHub({ type: "session_status", sessionId, status: "running" });

    if (response.kind === "allow") {
      return {
        behavior: "allow",
        updatedInput: response.updatedInput || input,
      };
    }
    return {
      behavior: "deny",
      message:
        response.kind === "deny"
          ? response.message || "User denied"
          : "User denied",
    };
  }

  // ── Stream message processing ─────────────────────────────────────────

  private processStreamMessage(msg: any, session: ActiveSession): void {
    const { sessionId } = session;
    switch (msg.type) {
      case "stream_event": {
        const e = msg.event;
        if (
          e?.type === "content_block_delta" &&
          e?.delta?.type === "text_delta"
        ) {
          this.sendToHub({
            type: "stream_text",
            sessionId,
            content: e.delta.text,
          });
        }
        break;
      }
      case "assistant": {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const bl of content) {
            if (bl.type === "tool_use" && bl.name !== ASK_USER_TOOL) {
              if (typeof bl.id !== "string") {
                this.dropToolBlock(
                  sessionId,
                  { blockType: "tool_use", reason: "missing_id" },
                  bl,
                );
                continue;
              }
              this.sendToHub({
                type: "tool_call",
                sessionId,
                toolCallId: bl.id,
                toolName: bl.name,
                display: formatToolDisplay(bl.name, bl.input),
              });
            }
          }
        }
        break;
      }
      case "user": {
        const content = msg.message?.content;
        if (Array.isArray(content)) {
          for (const bl of content) {
            if (bl.type === "tool_result") {
              if (typeof bl.tool_use_id !== "string") {
                this.dropToolBlock(
                  sessionId,
                  { blockType: "tool_result", reason: "missing_tool_use_id" },
                  bl,
                );
                continue;
              }
              const text = extractToolResultText(bl.content);
              if (text)
                this.sendToHub({
                  type: "tool_result",
                  sessionId,
                  toolCallId: bl.tool_use_id,
                  content: text.slice(0, 2000),
                });
            }
          }
        }
        break;
      }
      case "result": {
        session.sdkSessionId = msg.session_id || null;
        this.sendToHub({
          type: "session_done",
          sessionId,
          sdkSessionId: msg.session_id || "",
          numTurns: msg.num_turns || 0,
          durationMs: msg.duration_ms || 0,
          totalCostUsd: msg.total_cost_usd,
        });
        break;
      }
      case "system": {
        if (msg.subtype === "init")
          session.sdkSessionId = msg.session_id || null;
        break;
      }
    }
  }

  // ── History ───────────────────────────────────────────────────────────

  private async getHistory(
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    const sdkSessionId = this.resolveSdkSessionId(sessionId);
    if (!sdkSessionId) {
      this.sendToHub({
        type: "session_history",
        sessionId,
        requestId,
        messages: [],
        error: "no_session",
      });
      return;
    }
    try {
      const messages = await this.getSessionMessagesFn(sdkSessionId, {
        limit: 100,
      });
      this.sendToHub({
        type: "session_history",
        sessionId,
        requestId,
        messages,
      });
    } catch {
      this.sendToHub({
        type: "session_history",
        sessionId,
        requestId,
        messages: [],
        error: "fetch_failed",
      });
    }
  }

  private dropToolBlock(
    sessionId: string,
    payload: DroppedToolBlockPayload,
    raw: unknown,
  ): void {
    // Surface SDK shape drift at the source instead of as a silent
    // hub-side rejection downstream. The dropped_tool_block message
    // is the structured signal; the log line is the human view; the
    // metric is the operator view (counted on both runner and hub so
    // an offline runner still has local accounting).
    this.metrics.inc(RUNNER_METRIC.DROPPED_TOOL_BLOCK, {
      block_type: payload.blockType,
      reason: payload.reason,
    });
    this.log.error("dropped tool block", {
      sessionId,
      blockType: payload.blockType,
      reason: payload.reason,
      sample: JSON.stringify(raw).slice(0, 200),
    });
    this.sendToHub({
      type: "dropped_tool_block",
      sessionId,
      ...payload,
    } as DroppedToolBlockMsg);
  }

  // ── Prompt resolution ─────────────────────────────────────────────────

  private waitForPromptResponse(
    session: ActiveSession,
    promptId: string,
  ): Promise<UserPromptResponse> {
    return new Promise((resolve) => {
      session.pendingPrompts.set(promptId, resolve);
    });
  }

  private resolvePrompt(
    sessionId: string,
    promptId: string,
    response: UserPromptResponse,
  ): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    const resolver = session.pendingPrompts.get(promptId);
    if (resolver) {
      session.pendingPrompts.delete(promptId);
      resolver(response);
    }
  }
}

/** Returns an error string on failure (relative / missing / not a
 *  directory), or null if `cwd` is safe to hand to the SDK. */
function validateCwd(cwd: string): string | null {
  if (!isAbsolute(cwd)) {
    return `Working directory must be an absolute path (got "${cwd}")`;
  }
  let stat;
  try {
    stat = statSync(cwd);
  } catch {
    return `Working directory does not exist: ${cwd}`;
  }
  if (!stat.isDirectory()) {
    return `Working directory is not a directory: ${cwd}`;
  }
  return null;
}

function rejectPendingPrompts(session: ActiveSession, message: string): void {
  for (const [, resolver] of session.pendingPrompts) {
    resolver({ kind: "deny", message });
  }
  session.pendingPrompts.clear();
}

function formatToolDisplay(
  name: string,
  input: Record<string, unknown> | undefined,
): string {
  if (name === "Bash" && input?.command) return "$ " + input.command;
  if (input?.file_path) return name + " " + input.file_path;
  if (input?.pattern) return name + " " + input.pattern;
  return name;
}

function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content))
    return content
      .filter((x: any) => x.type === "text")
      .map((x: any) => x.text)
      .join("\n");
  return "";
}
