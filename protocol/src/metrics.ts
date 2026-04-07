/**
 * In-memory counter store with periodic structured-JSON flush. Sufficient
 * for a single hub instance -- aggregator (Loki, Vector, journalctl) reads
 * the JSON lines off stdout. If/when the hub is horizontally scaled this
 * moves to push-based exposition (Prometheus pushgateway, OpenTelemetry).
 *
 * Counters only by design (no histograms / gauges yet). Adding those
 * would change the wire shape, so they're held back until there's a
 * concrete need.
 */

/**
 * INVARIANT: callers must only pass closed-set label values. The runtime
 * type allows arbitrary strings to keep the API ergonomic, but operator
 * dashboards rely on cardinality being bounded by code, not by traffic.
 * The A1 parser enforces the closed sets for all hub-side increments.
 */
export type MetricLabels = Record<string, string>;

/**
 * Canonical counter names. Centralized so a typo at a call site is a
 * compile error instead of a phantom counter that operators only
 * notice when their dashboard is silent. Mirrors A1's enum-validation
 * philosophy: closed sets at the boundary.
 */
export const HUB_METRIC = {
  PARSE_REJECT: "hub.parse_reject",
  HISTORY_TTL_EXPIRED: "hub.history_ttl_expired",
  HISTORY_ORPHAN_REPLY: "hub.history_orphan_reply",
  HISTORY_DEGRADED: "hub.history_degraded",
  DROPPED_TOOL_BLOCK: "hub.dropped_tool_block",
  RATE_LIMITED: "hub.rate_limited",
} as const;

export const RUNNER_METRIC = {
  PARSE_REJECT: "runner.parse_reject",
  DROPPED_TOOL_BLOCK: "runner.dropped_tool_block",
} as const;

export interface MetricsConfig {
  /** How often to emit a snapshot. Default 60s. */
  flushIntervalMs?: number;
  /** Injection seam for tests. Defaults to console.log. */
  emit?: (line: string) => void;
  /** Injection seam for tests. Defaults to Date.now. */
  now?: () => number;
}

export class Metrics {
  private counters: Map<string, number> = new Map();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private readonly flushIntervalMs: number;
  private readonly emit: (line: string) => void;
  private readonly now: () => number;

  constructor(config: MetricsConfig = {}) {
    this.flushIntervalMs = config.flushIntervalMs ?? 60_000;
    this.emit = config.emit ?? ((line) => console.log(line));
    this.now = config.now ?? Date.now;
  }

  /**
   * Increment a counter by 1. Labels are encoded into the key so the
   * snapshot remains a flat string→number map (matches journald /
   * Loki / OTEL counter shape).
   */
  inc(name: string, labels?: MetricLabels): void {
    const key = encodeKey(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + 1);
  }

  /** Cumulative snapshot. Counters are NEVER reset on snapshot/flush. */
  snapshot(): Record<string, number> {
    return Object.fromEntries(this.counters);
  }

  /** Start the periodic flush. Idempotent. */
  start(): void {
    if (this.flushTimer) return;
    this.flushTimer = setInterval(() => this.flush(), this.flushIntervalMs);
    // Don't keep the event loop alive just to flush metrics.
    this.flushTimer.unref?.();
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Emit a single JSON snapshot line. Public so callers can flush on demand. */
  flush(): void {
    if (this.counters.size === 0) return;
    const line = JSON.stringify({
      ts: new Date(this.now()).toISOString(),
      kind: "metrics",
      counters: this.snapshot(),
    });
    try {
      this.emit(line);
    } catch (err) {
      // Surface a broken sink instead of silently swallowing snapshots.
      // A flush failure used to vanish; now it lands on stderr at
      // least once per failure interval so an operator (or CC session
      // tailing logs) sees it.
      try {
        process.stderr.write(
          `[metrics] flush failed: ${(err as Error).message}\n`,
        );
      } catch {
        /* swallow -- absolute last resort */
      }
    }
  }
}

/**
 * Stable encoding so the same (name, labels) pair always lands in the
 * same map slot regardless of label insertion order.
 */
function encodeKey(name: string, labels?: MetricLabels): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${labels[k]}`)
    .join(",");
  return parts.length === 0 ? name : `${name}{${parts}}`;
}
