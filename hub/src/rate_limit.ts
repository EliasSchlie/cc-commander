/**
 * Tiny in-memory token bucket. Sufficient for a single hub instance --
 * if/when the hub is horizontally scaled this should move to a shared
 * store (Redis, DB), at which point this file can be replaced wholesale.
 *
 * Each `key` (e.g. an IP, an account id) gets its own bucket lazily.
 * Stale buckets are evicted by a periodic sweep so the map cannot grow
 * unbounded under attack.
 */
export interface TokenBucketConfig {
  /** Maximum tokens the bucket can hold (and starting balance). */
  capacity: number;
  /** Tokens refilled per millisecond. e.g. 5 / 60_000 = 5 per minute. */
  refillPerMs: number;
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketRateLimiter {
  private buckets: Map<string, BucketState> = new Map();
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private readonly config: TokenBucketConfig;
  private readonly now: () => number;

  constructor(config: TokenBucketConfig, now: () => number = Date.now) {
    this.config = config;
    this.now = now;
  }

  /**
   * Try to consume one token for `key`. Returns true on success and
   * false if the caller is rate limited.
   */
  tryConsume(key: string): boolean {
    const t = this.now();
    const bucket = this.buckets.get(key);
    if (!bucket) {
      // First hit: bucket starts full, immediately spend one token.
      this.buckets.set(key, {
        tokens: this.config.capacity - 1,
        lastRefillMs: t,
      });
      return true;
    }
    const elapsed = t - bucket.lastRefillMs;
    bucket.tokens = Math.min(
      this.config.capacity,
      bucket.tokens + elapsed * this.config.refillPerMs,
    );
    bucket.lastRefillMs = t;
    if (bucket.tokens < 1) return false;
    bucket.tokens -= 1;
    return true;
  }

  /**
   * Periodically drop buckets that have been idle long enough to be
   * fully refilled. Call once on hub start; the returned handle is also
   * stored internally so `stop()` can clear it.
   */
  startSweeping(intervalMs: number = 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref();
  }

  stop(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  /** Visible for tests. */
  sweep(): void {
    const t = this.now();
    // A bucket is "fully refilled" once `capacity / refillPerMs` ms have
    // passed since its last update. After that point it's
    // indistinguishable from a fresh bucket and can be dropped.
    const fullRefillMs = this.config.capacity / this.config.refillPerMs;
    for (const [key, bucket] of this.buckets) {
      if (t - bucket.lastRefillMs >= fullRefillMs) {
        this.buckets.delete(key);
      }
    }
  }

  /** Visible for tests. */
  size(): number {
    return this.buckets.size;
  }
}
