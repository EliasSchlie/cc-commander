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
export interface UpdaterConfig {
  hubBaseUrl: string;
  currentVersion: string;
  pollIntervalMs?: number;
  onUpdateNeeded: (hubVersion: string) => Promise<void> | void;
  /** Override fetch for tests. */
  fetchFn?: typeof fetch;
}

const DEFAULT_POLL_INTERVAL_MS = 5 * 60 * 1000;

export class Updater {
  private config: UpdaterConfig;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private fetchFn: typeof fetch;
  private versionUrl: string;

  constructor(config: UpdaterConfig) {
    this.config = config;
    this.fetchFn = config.fetchFn ?? fetch;
    this.versionUrl = new URL("/api/version", config.hubBaseUrl).toString();
  }

  start(): void {
    if (!this.config.currentVersion) {
      console.log(
        "[updater] runner version unknown (no git checkout?); self-update disabled",
      );
      return;
    }
    this.stopped = false;
    console.log(
      `[updater] polling ${this.versionUrl} every ${this.intervalMs() / 1000}s (current=${this.config.currentVersion})`,
    );
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
    let hubVersion: string;
    try {
      const res = await this.fetchFn(this.versionUrl);
      if (!res.ok) {
        console.error(`[updater] hub /api/version returned ${res.status}`);
        return "skipped";
      }
      const data = (await res.json()) as { version?: unknown };
      hubVersion = typeof data.version === "string" ? data.version : "";
    } catch (err) {
      console.error(
        `[updater] hub /api/version request failed: ${String(err)}`,
      );
      return "skipped";
    }

    // Hub without a baked VERSION (dev hub) — never try to update against
    // an unknown target.
    if (!hubVersion) return "skipped";
    if (hubVersion === this.config.currentVersion) return "matched";

    console.log(
      `[updater] version mismatch: runner=${this.config.currentVersion} hub=${hubVersion}; updating...`,
    );
    try {
      await this.config.onUpdateNeeded(hubVersion);
    } catch (err) {
      console.error(`[updater] update handler failed: ${String(err)}`);
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
        console.error(`[updater] check failed: ${String(err)}`);
      }
      this.scheduleNext();
    }, this.intervalMs());
  }

  private intervalMs(): number {
    return this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  }
}
