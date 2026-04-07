/**
 * Polls the hub's /api/version endpoint and triggers a self-update when
 * the hub's version differs from the runner's current version.
 *
 * This is the mechanism that lets every commit to the hub propagate to
 * every runner within `pollIntervalMs` (default 5 min). On a tag push:
 *   - CI builds the hub image with VERSION=<sha>, restarts the VPS hub
 *   - Each runner polls /api/version on its next tick
 *   - If hub sha != runner sha, runner runs onUpdateNeeded() and exits
 *   - launchd (KeepAlive=true) restarts the runner against the new code
 *
 * Self-update is disabled (no-op) when either side has an empty version
 * string. That is the local-dev case: a hand-started runner against a
 * locally-started hub should never auto-restart itself.
 */
import { createLogger, type Logger } from "@cc-commander/protocol/logger";

export interface UpdaterConfig {
  hubBaseUrl: string;
  currentVersion: string;
  pollIntervalMs?: number;
  onUpdateNeeded: (hubVersion: string) => Promise<void> | void;
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
  /** Inject a Logger (mostly for tests). */
  logger?: Logger;
}

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

export class Updater {
  private config: UpdaterConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private fetchFn: typeof fetch;
  private versionUrl: string;

  private log: Logger;

  constructor(config: UpdaterConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn ?? fetch;
    this.versionUrl = new URL("/api/version", config.hubBaseUrl).toString();
    this.log = config.logger ?? createLogger("updater");
  }

  start(): void {
    if (!this.config.currentVersion) {
      this.log.info("runner version unknown; self-update disabled", {
        hint: "no git checkout?",
      });
      return;
    }
    this.stopped = false;
    this.log.info("polling for updates", {
      url: this.versionUrl,
      intervalSec: this.intervalMs() / 1000,
      currentVersion: this.config.currentVersion,
    });
    this.scheduleNext();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Run one poll cycle and return what happened. Production code calls
   * this from the scheduled timer; tests call it directly.
   */
  async checkOnce(): Promise<"matched" | "skipped" | "update"> {
    let res: Response;
    try {
      res = await this.fetchFn(this.versionUrl);
    } catch (err) {
      this.log.error("version request failed", { err: err as Error });
      return "skipped";
    }
    if (!res.ok) {
      this.log.error("version returned non-2xx", { status: res.status });
      return "skipped";
    }
    let hubVersion: string;
    try {
      const data = (await res.json()) as { version?: unknown };
      hubVersion = typeof data.version === "string" ? data.version : "";
      if (typeof data.version !== "string") {
        this.log.warn("version body missing string version field", {
          got: typeof data.version,
        });
      }
    } catch (err) {
      this.log.error("version returned non-JSON body", { err: err as Error });
      return "skipped";
    }

    // Hub without a baked VERSION (dev hub) — never try to update against
    // an unknown target.
    if (!hubVersion) return "skipped";
    if (hubVersion === this.config.currentVersion) return "matched";

    this.log.info("version mismatch -- updating", {
      runner: this.config.currentVersion,
      hub: hubVersion,
    });
    try {
      await this.config.onUpdateNeeded(hubVersion);
    } catch (err) {
      this.log.error("update handler failed", { err: err as Error });
    }
    return "update";
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        await this.checkOnce();
      } catch (err) {
        this.log.error("check failed", { err: err as Error });
      }
      this.scheduleNext();
    }, this.intervalMs());
  }

  private intervalMs(): number {
    return this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }
}
