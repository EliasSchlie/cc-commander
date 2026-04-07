/**
 * Tracks in-flight `get_session_history` requests so the runner reply
 * can be routed back to the asking client even though WebSocket replies
 * arrive on a different connection. Each entry carries a TTL timer so
 * a runner that stays connected but never replies (deadlock, dropped
 * message, bug) can't leave the client spinning forever.
 *
 * Behavior is unchanged from when this lived inline on the Hub class;
 * extracted to keep Hub focused on wiring and to make the lifecycle
 * (add → take | dropMatching | clear) testable in isolation.
 */
import type { ClientConnection } from "../ws/types.ts";

/** Default TTL when none is supplied. 30s matches the prior inline default. */
export const DEFAULT_PENDING_HISTORY_TTL_MS = 30_000;

interface PendingHistoryEntryInput {
  conn: ClientConnection;
  machineId: string;
}

interface PendingHistoryEntry extends PendingHistoryEntryInput {
  timer: ReturnType<typeof setTimeout>;
}

export class PendingHistoryStore {
  private entries: Map<string, PendingHistoryEntry> = new Map();
  private readonly ttlMs: number;

  constructor(ttlMs: number = DEFAULT_PENDING_HISTORY_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Register a new pending request. `onExpire` is invoked if the TTL
   * fires before `take(requestId)` is called -- the entry has already
   * been removed from the store by then, so the callback only needs
   * to deliver the timeout reply (and increment any metric).
   */
  add(
    requestId: string,
    entry: PendingHistoryEntryInput,
    onExpire: (entry: PendingHistoryEntryInput) => void,
  ): void {
    const timer = setTimeout(() => {
      const e = this.entries.get(requestId);
      if (!e) return;
      this.entries.delete(requestId);
      onExpire({ conn: e.conn, machineId: e.machineId });
    }, this.ttlMs);
    timer.unref();
    this.entries.set(requestId, { ...entry, timer });
  }

  /**
   * Look up an entry without removing it. Used by callers that want
   * to validate the entry (e.g. machineId match) before committing
   * to take(); a failing validation must NOT consume the entry,
   * because the legitimate reply may still be in flight.
   */
  peek(requestId: string): PendingHistoryEntryInput | null {
    const e = this.entries.get(requestId);
    return e ? { conn: e.conn, machineId: e.machineId } : null;
  }

  /**
   * Look up and remove an entry. Cancels its TTL timer. Returns null
   * if there's no entry for `requestId` (already expired, never
   * existed, or already taken).
   */
  take(requestId: string): PendingHistoryEntryInput | null {
    const e = this.entries.get(requestId);
    if (!e) return null;
    clearTimeout(e.timer);
    this.entries.delete(requestId);
    return { conn: e.conn, machineId: e.machineId };
  }

  /**
   * Drop every entry the predicate accepts. Used when a runner
   * disconnects (drop by machineId) or a client disconnects (drop by
   * conn) so half-resolved requests don't accumulate.
   */
  dropMatching(predicate: (entry: PendingHistoryEntryInput) => boolean): void {
    if (this.entries.size === 0) return;
    for (const [requestId, e] of this.entries) {
      if (predicate({ conn: e.conn, machineId: e.machineId })) {
        clearTimeout(e.timer);
        this.entries.delete(requestId);
      }
    }
  }

  /** Cancel all TTL timers and empty the store. Used by Hub.stop(). */
  clear(): void {
    for (const [, e] of this.entries) clearTimeout(e.timer);
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }
}
