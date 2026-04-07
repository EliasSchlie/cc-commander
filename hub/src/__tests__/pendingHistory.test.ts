import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_PENDING_HISTORY_TTL_MS,
  PendingHistoryStore,
} from "../state/pendingHistory.ts";
import type { ClientConnection } from "../ws/types.ts";

// Bare minimum stand-in: tests only check identity, never call ws methods.
const fakeConn = (): ClientConnection =>
  ({ accountId: "a", email: "e" }) as unknown as ClientConnection;

describe("PendingHistoryStore", () => {
  let store: PendingHistoryStore;

  beforeEach(() => {
    // 5ms TTL keeps the suite fast; the timer is unref'd anyway.
    store = new PendingHistoryStore(5);
  });

  afterEach(() => {
    store.clear();
  });

  // Prevents: regression where the wrong entry comes back from take()
  it("add then take returns the same entry and clears the store", () => {
    const conn = fakeConn();
    store.add("r1", { conn, machineId: "m1" }, () => {
      assert.fail("onExpire must not fire after take()");
    });
    assert.equal(store.size, 1);
    const taken = store.take("r1");
    assert.ok(taken);
    assert.equal(taken.conn, conn);
    assert.equal(taken.machineId, "m1");
    assert.equal(store.size, 0);
  });

  // Prevents: a missing entry returning a stale value or throwing
  it("take returns null for unknown requestId", () => {
    assert.equal(store.take("nope"), null);
  });

  // Prevents: peek mutating the store (peek must be side-effect free)
  it("peek does not remove or mutate the entry", () => {
    store.add("r1", { conn: fakeConn(), machineId: "m1" }, () => {});
    assert.equal(store.peek("r1")?.machineId, "m1");
    assert.equal(store.size, 1);
    assert.equal(store.peek("r1")?.machineId, "m1");
    assert.equal(store.size, 1);
  });

  // Prevents: TTL expiry not firing onExpire (the whole point of the
  // TTL is to unblock the client when the runner never replies)
  it("onExpire fires once after the TTL elapses", async () => {
    let fired = 0;
    let captured: { machineId: string } | null = null;
    store.add("r1", { conn: fakeConn(), machineId: "m1" }, (entry) => {
      fired += 1;
      captured = entry;
    });
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(fired, 1);
    assert.equal(captured!.machineId, "m1");
    // Entry was removed by the timer; subsequent take returns null.
    assert.equal(store.take("r1"), null);
  });

  // Prevents: take() after expiry double-fire (timer + take both
  // delivering the same entry)
  it("take after onExpire returns null", async () => {
    store.add("r1", { conn: fakeConn(), machineId: "m1" }, () => {});
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(store.take("r1"), null);
  });

  // Prevents: timer firing AFTER take() and double-delivering
  it("take cancels the TTL timer", async () => {
    let fired = 0;
    store.add("r1", { conn: fakeConn(), machineId: "m1" }, () => {
      fired += 1;
    });
    store.take("r1");
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(fired, 0);
  });

  // Prevents: dropMatching leaving timers alive (would later fire
  // onExpire on a long-since-removed entry)
  it("dropMatching cancels timers for matched entries", async () => {
    let fired = 0;
    store.add("r1", { conn: fakeConn(), machineId: "m1" }, () => {
      fired += 1;
    });
    store.add("r2", { conn: fakeConn(), machineId: "m2" }, () => {
      fired += 1;
    });
    store.dropMatching((entry) => entry.machineId === "m1");
    assert.equal(store.size, 1);
    assert.equal(store.peek("r1"), null);
    assert.equal(store.peek("r2")?.machineId, "m2");
    await new Promise((r) => setTimeout(r, 25));
    // Only r2's timer should have fired (m1 was dropped).
    assert.equal(fired, 1);
  });

  // Prevents: clear() leaving timers alive after Hub.stop()
  it("clear cancels every timer and empties the store", async () => {
    let fired = 0;
    store.add("r1", { conn: fakeConn(), machineId: "m1" }, () => {
      fired += 1;
    });
    store.add("r2", { conn: fakeConn(), machineId: "m2" }, () => {
      fired += 1;
    });
    store.clear();
    assert.equal(store.size, 0);
    await new Promise((r) => setTimeout(r, 25));
    assert.equal(fired, 0);
  });

  // Prevents: the exported default drifting from the prior 30s value
  it("DEFAULT_PENDING_HISTORY_TTL_MS preserves the prior 30s default", () => {
    assert.equal(DEFAULT_PENDING_HISTORY_TTL_MS, 30_000);
  });
});
