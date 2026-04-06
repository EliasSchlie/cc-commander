import { WebSocket } from "ws";
import { query, getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import { parseMessage, serializeMessage } from "@cc-commander/shared";
import type {
  HubToMachineMsg,
  MachineToHubMsg,
  UserPromptResponse,
} from "@cc-commander/shared";

interface ActiveSession {
  sessionId: string;
  sdkSessionId: string | null;
  abortController: AbortController;
  /** Map of promptId -> resolver for canUseTool callbacks */
  pendingPrompts: Map<string, (response: UserPromptResponse) => void>;
}

/** Function signature matching the SDK query() call */
export type QueryFn = typeof query;
/** Function signature matching getSessionMessages */
export type GetSessionMessagesFn = typeof getSessionMessages;

export interface AgentConfig {
  hubUrl: string;
  registrationToken: string;
  machineName: string;
  reconnectIntervalMs?: number;
  /** Override for testing -- defaults to SDK query() */
  queryFn?: QueryFn;
  /** Override for testing -- defaults to SDK getSessionMessages() */
  getSessionMessagesFn?: GetSessionMessagesFn;
}

export class MachineAgent {
  config: AgentConfig;
  ws: WebSocket | null;
  sessions: Map<string, ActiveSession>;
  shouldReconnect: boolean;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  queryFn: QueryFn;
  getSessionMessagesFn: GetSessionMessagesFn;

  constructor(config: AgentConfig) {
    this.config = config;
    this.ws = null;
    this.sessions = new Map();
    this.shouldReconnect = true;
    this.reconnectTimer = null;
    this.queryFn = config.queryFn || query;
    this.getSessionMessagesFn =
      config.getSessionMessagesFn || getSessionMessages;
  }

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.config.hubUrl}/ws/machine?token=${this.config.registrationToken}`;
      this.ws = new WebSocket(url);

      this.ws.on("open", () => {
        console.log(`[agent] Connected to hub as "${this.config.machineName}"`);
        this.sendToHub({
          type: "machine_hello",
          machineName: this.config.machineName,
        });
        resolve();
      });

      this.ws.on("message", (data) => {
        try {
          const msg = parseMessage<HubToMachineMsg>(data.toString());
          this.handleMessage(msg);
        } catch (err) {
          console.error("[agent] Invalid message from hub:", err);
        }
      });

      this.ws.on("close", () => {
        console.log("[agent] Disconnected from hub");
        if (this.shouldReconnect) {
          const delay = this.config.reconnectIntervalMs ?? 5000;
          console.log(`[agent] Reconnecting in ${delay}ms...`);
          this.reconnectTimer = setTimeout(() => {
            this.connect().catch(console.error);
          }, delay);
        }
      });

      this.ws.on("error", (err) => {
        console.error("[agent] WebSocket error:", err.message);
        reject(err);
      });
    });
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Abort all active sessions
    for (const [, session] of this.sessions) {
      session.abortController.abort();
    }
    this.sessions.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  private sendToHub(msg: MachineToHubMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(serializeMessage(msg));
    }
  }

  private handleMessage(msg: HubToMachineMsg): void {
    switch (msg.type) {
      case "hub_start_session":
        this.startSession(msg.sessionId, msg.directory, msg.prompt);
        break;
      case "hub_send_prompt":
        this.sendPrompt(msg.sessionId, msg.prompt);
        break;
      case "hub_respond_to_prompt":
        this.resolvePrompt(msg.sessionId, msg.promptId, msg.response);
        break;
      case "hub_get_history":
        this.getHistory(msg.sessionId, msg.requestId);
        break;
    }
  }

  private async startSession(
    sessionId: string,
    directory: string,
    prompt: string,
  ): Promise<void> {
    const abortController = new AbortController();
    const session: ActiveSession = {
      sessionId,
      sdkSessionId: null,
      abortController,
      pendingPrompts: new Map(),
    };
    this.sessions.set(sessionId, session);

    this.sendToHub({
      type: "session_status",
      sessionId,
      status: "running",
    });

    let promptCounter = 0;

    try {
      const q = this.queryFn({
        prompt,
        options: {
          cwd: directory,
          maxTurns: 50,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          abortController,
          canUseTool: async (toolName, input, opts) => {
            const promptId = `${sessionId}-${++promptCounter}`;

            if (toolName === "AskUserQuestion") {
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
                lastMessagePreview:
                  questions[0]?.question || "Waiting for input",
              });

              const response = await this.waitForPromptResponse(
                session,
                promptId,
              );

              this.sendToHub({
                type: "session_status",
                sessionId,
                status: "running",
              });

              if (response.kind === "answers") {
                return {
                  behavior: "allow" as const,
                  updatedInput: {
                    questions: (input as any).questions,
                    answers: response.answers,
                  },
                };
              }
              return { behavior: "deny" as const, message: "User cancelled" };
            }

            // Unknown interaction tool -- relay allow/deny to device
            this.sendToHub({
              type: "user_prompt",
              sessionId,
              promptId,
              toolName,
              title: opts.title,
              input: input as Record<string, unknown>,
            });

            this.sendToHub({
              type: "session_status",
              sessionId,
              status: "waiting_for_input",
            });

            const response = await this.waitForPromptResponse(
              session,
              promptId,
            );

            this.sendToHub({
              type: "session_status",
              sessionId,
              status: "running",
            });

            if (response.kind === "allow") {
              return {
                behavior: "allow" as const,
                updatedInput:
                  response.updatedInput || (input as Record<string, unknown>),
              };
            }
            return {
              behavior: "deny" as const,
              message:
                response.kind === "deny"
                  ? response.message || "User denied"
                  : "User denied",
            };
          },
        },
      });

      for await (const msg of q) {
        switch (msg.type) {
          case "stream_event": {
            const e = (msg as any).event;
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
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const bl of content) {
                if (bl.type === "tool_use" && bl.name !== "AskUserQuestion") {
                  let display = bl.name;
                  if (bl.name === "Bash" && bl.input?.command)
                    display = "$ " + bl.input.command;
                  else if (bl.input?.file_path)
                    display = bl.name + " " + bl.input.file_path;
                  else if (bl.input?.pattern)
                    display = bl.name + " " + bl.input.pattern;
                  this.sendToHub({
                    type: "tool_call",
                    sessionId,
                    toolName: bl.name,
                    display,
                  });
                }
              }
            }
            break;
          }

          case "user": {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const bl of content) {
                if (bl.type === "tool_result") {
                  const text =
                    typeof bl.content === "string"
                      ? bl.content
                      : Array.isArray(bl.content)
                        ? bl.content
                            .filter((x: any) => x.type === "text")
                            .map((x: any) => x.text)
                            .join("\n")
                        : "";
                  if (text) {
                    this.sendToHub({
                      type: "tool_result",
                      sessionId,
                      content: text.slice(0, 2000),
                    });
                  }
                }
              }
            }
            break;
          }

          case "result": {
            const result = msg as any;
            session.sdkSessionId = result.session_id || null;
            this.sendToHub({
              type: "session_done",
              sessionId,
              sdkSessionId: result.session_id || "",
              numTurns: result.num_turns || 0,
              durationMs: result.duration_ms || 0,
              totalCostUsd: result.total_cost_usd,
            });
            break;
          }

          case "system": {
            // Capture session_id from init
            if ((msg as any).subtype === "init") {
              session.sdkSessionId = (msg as any).session_id || null;
            }
            break;
          }
        }
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
      this.sessions.delete(sessionId);
    }
  }

  private async sendPrompt(sessionId: string, prompt: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.sdkSessionId) {
      // No active session to resume -- start a new one with resume
      this.startSessionWithResume(sessionId, prompt);
      return;
    }

    // For follow-up prompts, we need to start a new query with resume
    this.startSessionWithResume(sessionId, prompt);
  }

  private async startSessionWithResume(
    sessionId: string,
    prompt: string,
  ): Promise<void> {
    const existing = this.sessions.get(sessionId);
    const sdkSessionId = existing?.sdkSessionId;

    // Abort existing query if running
    if (existing) {
      existing.abortController.abort();
    }

    const abortController = new AbortController();
    const session: ActiveSession = {
      sessionId,
      sdkSessionId: sdkSessionId || null,
      abortController,
      pendingPrompts: new Map(),
    };
    this.sessions.set(sessionId, session);

    this.sendToHub({
      type: "session_status",
      sessionId,
      status: "running",
    });

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
          // Same canUseTool logic as startSession
          const promptId = `${sessionId}-${++promptCounter}`;

          if (toolName === "AskUserQuestion") {
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
            const response = await this.waitForPromptResponse(
              session,
              promptId,
            );
            if (response.kind === "answers") {
              return {
                behavior: "allow" as const,
                updatedInput: {
                  questions: (input as any).questions,
                  answers: response.answers,
                },
              };
            }
            return { behavior: "deny" as const, message: "User cancelled" };
          }

          this.sendToHub({
            type: "user_prompt",
            sessionId,
            promptId,
            toolName,
            title: opts.title,
            input,
          });
          const response = await this.waitForPromptResponse(session, promptId);
          if (response.kind === "allow") {
            return {
              behavior: "allow" as const,
              updatedInput: response.updatedInput || input,
            };
          }
          return {
            behavior: "deny" as const,
            message:
              response.kind === "deny"
                ? response.message || "Denied"
                : "Denied",
          };
        },
      };

      if (sdkSessionId) {
        options.resume = sdkSessionId;
      }

      for await (const msg of this.queryFn({ prompt, options })) {
        // Same message handling as startSession
        switch (msg.type) {
          case "stream_event": {
            const e = (msg as any).event;
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
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const bl of content) {
                if (bl.type === "tool_use" && bl.name !== "AskUserQuestion") {
                  let display = bl.name;
                  if (bl.name === "Bash" && bl.input?.command)
                    display = "$ " + bl.input.command;
                  else if (bl.input?.file_path)
                    display = bl.name + " " + bl.input.file_path;
                  this.sendToHub({
                    type: "tool_call",
                    sessionId,
                    toolName: bl.name,
                    display,
                  });
                }
              }
            }
            break;
          }
          case "user": {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const bl of content) {
                if (bl.type === "tool_result") {
                  const text =
                    typeof bl.content === "string"
                      ? bl.content
                      : Array.isArray(bl.content)
                        ? bl.content
                            .filter((x: any) => x.type === "text")
                            .map((x: any) => x.text)
                            .join("\n")
                        : "";
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
            const result = msg as any;
            session.sdkSessionId = result.session_id || null;
            this.sendToHub({
              type: "session_done",
              sessionId,
              sdkSessionId: result.session_id || "",
              numTurns: result.num_turns || 0,
              durationMs: result.duration_ms || 0,
              totalCostUsd: result.total_cost_usd,
            });
            break;
          }
        }
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
      this.sessions.delete(sessionId);
    }
  }

  private async getHistory(
    sessionId: string,
    requestId: string,
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    const sdkSessionId = session?.sdkSessionId;

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
    } catch (err) {
      this.sendToHub({
        type: "session_history",
        sessionId,
        requestId,
        messages: [],
      });
    }
  }

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
