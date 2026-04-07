import { WebSocket } from "ws";
import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { parseHubMessage, serialize } from "./protocol.ts";
import type {
  HubToRunnerMsg,
  RunnerToHubMsg,
  UserPromptResponse,
} from "./protocol.ts";

const ASK_USER_TOOL = "AskUserQuestion";
const MAX_SDK_SESSION_IDS = 1000;

interface ActiveSession {
  sessionId: string;
  sdkSessionId: string | null;
  abortController: AbortController;
  pendingPrompts: Map<string, (response: UserPromptResponse) => void>;
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
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.config.hubUrl}/ws/runner?token=${this.config.registrationToken}`;
      this.ws = new WebSocket(url);
      let connected = false;

      this.ws.on("open", () => {
        connected = true;
        console.log(`[runner] Connected to hub as "${this.config.machineName}"`);
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
          console.error("[runner] Invalid message from hub:", err);
        }
      });

      this.ws.on("close", () => {
        console.log("[runner] Disconnected from hub");
        if (connected && this.shouldReconnect) {
          const delay = this.config.reconnectIntervalMs ?? 5000;
          console.log(`[runner] Reconnecting in ${delay}ms...`);
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch(console.error);
          }, delay);
        }
      });

      this.ws.on("error", (err) => {
        console.error("[runner] WebSocket error:", err.message);
        if (!connected) reject(err);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const [, session] of this.sessions) {
      session.abortController.abort();
      // Reject any pending prompt promises so canUseTool doesn't hang
      for (const [, resolver] of session.pendingPrompts) {
        resolver({ kind: "deny", message: "Runner disconnected" });
      }
      session.pendingPrompts.clear();
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
    }
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
    const existing = this.sessions.get(sessionId);
    if (existing) existing.abortController.abort();

    const abortController = new AbortController();
    const session: ActiveSession = {
      sessionId,
      sdkSessionId: extra.resume || this.resolveSdkSessionId(sessionId) || null,
      abortController,
      pendingPrompts: new Map(),
    };
    this.sessions.set(sessionId, session);
    this.sendToHub({ type: "session_status", sessionId, status: "running" });

    let promptCounter = 0;

    try {
      const options: Record<string, any> = {
        maxTurns: 50,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        includePartialMessages: true,
        abortController,
        canUseTool: async (
          toolName: string,
          input: Record<string, unknown>,
          opts: any,
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

      for await (const msg of this.queryFn({ prompt, options })) {
        this.processStreamMessage(msg, session);
      }
    } catch (err) {
      if (!abortController.signal.aborted) {
        this.sendToHub({
          type: "session_error",
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      if (session.sdkSessionId) {
        // Evict oldest entry if at capacity
        if (this.sdkSessionIds.size >= MAX_SDK_SESSION_IDS) {
          const oldest = this.sdkSessionIds.keys().next().value;
          if (oldest !== undefined) this.sdkSessionIds.delete(oldest);
        }
        this.sdkSessionIds.set(sessionId, session.sdkSessionId);
      }
      this.sessions.delete(sessionId);
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
    opts: any,
  ): Promise<
    | { behavior: "allow"; updatedInput?: Record<string, unknown> }
    | { behavior: "deny"; message: string }
  > {
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
              this.sendToHub({
                type: "tool_call",
                sessionId,
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
              const text = extractToolResultText(bl.content);
              if (text)
                this.sendToHub({
                  type: "tool_result",
                  sessionId,
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
      });
    }
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
