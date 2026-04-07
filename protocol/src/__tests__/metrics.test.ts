import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Metrics } from "../metrics.ts";

describe("Metrics", () => {
  // Counters are flat string→number; the snapshot must reflect every
  // increment regardless of label insertion order.
  it("increments and snapshots labeled counters", () => {
    const m = new Metrics();
    m.inc("dropped");
    m.inc("dropped");
    m.inc("dropped_with_labels", { reason: "missing_id", block: "tool_use" });
    m.inc("dropped_with_labels", { block: "tool_use", reason: "missing_id" });
    const snap = m.snapshot();
    assert.equal(snap["dropped"], 2);
    assert.equal(
      snap["dropped_with_labels{block=tool_use,reason=missing_id}"],
      2,
    );
  });

  // Stable key encoding so the same (name, labels) always lands in the
  // same map slot regardless of insertion order. Without this, label
  // reordering would silently double-count.
  it("encodes labels in sorted order", () => {
    const m = new Metrics();
    m.inc("c", { b: "2", a: "1" });
    m.inc("c", { a: "1", b: "2" });
    const snap = m.snapshot();
    assert.equal(Object.keys(snap).length, 1);
    assert.equal(snap["c{a=1,b=2}"], 2);
  });

  // Snapshots are cumulative: the operator computes deltas externally,
  // so reset-on-flush would silently lose data between scrapes.
  it("flush emits a single JSON line and does not reset counters", () => {
    const lines: string[] = [];
    const m = new Metrics({
      flushIntervalMs: 1_000_000,
      emit: (line) => lines.push(line),
      now: () => 1_700_000_000_000,
    });
    m.inc("foo");
    m.inc("bar");
    m.flush();
    assert.equal(lines.length, 1);
    const parsed = JSON.parse(lines[0]) as {
      kind: string;
      ts: string;
      counters: Record<string, number>;
    };
    assert.equal(parsed.kind, "metrics");
    assert.equal(parsed.ts, "2023-11-14T22:13:20.000Z");
    assert.equal(parsed.counters.foo, 1);
    assert.equal(parsed.counters.bar, 1);
    // Cumulative: counters survive the flush.
    assert.deepEqual(m.snapshot(), { foo: 1, bar: 1 });
  });

  // No counters → no log line. Otherwise idle hubs would emit empty
  // metric lines forever.
  it("flush is a no-op when no counters have been incremented", () => {
    const lines: string[] = [];
    const m = new Metrics({ emit: (line) => lines.push(line) });
    m.flush();
    assert.equal(lines.length, 0);
  });

  // start() schedules periodic flushes; stop() cancels them. The unref
  // contract is checked indirectly by the lack of a hung process in CI.
  it("start schedules periodic flushes; stop cancels them", async () => {
    const lines: string[] = [];
    const m = new Metrics({
      flushIntervalMs: 5,
      emit: (line) => lines.push(line),
    });
    m.inc("ticks");
    m.start();
    await new Promise((r) => setTimeout(r, 30));
    m.stop();
    const after = lines.length;
    assert.ok(after >= 1, "expected at least one flush within 30ms");
    await new Promise((r) => setTimeout(r, 20));
    // No additional flushes after stop().
    assert.equal(lines.length, after);
  });

  // Idempotency: start() called twice must not double-schedule. Asserted
  // by reference identity on the internal timer rather than wall-clock
  // counting (which is flaky on loaded CI).
  it("start is idempotent", () => {
    const m = new Metrics({ flushIntervalMs: 1_000_000 });
    m.start();
    // Reach into the private field via index access. Acceptable in
    // tests; the alternative is exposing a getter solely for testing.
    const first = (m as unknown as { flushTimer: unknown }).flushTimer;
    m.start();
    const second = (m as unknown as { flushTimer: unknown }).flushTimer;
    assert.strictEqual(first, second, "second start must reuse the timer");
    m.stop();
  });
});
