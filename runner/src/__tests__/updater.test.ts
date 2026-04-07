import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Updater } from "../updater.ts";

function makeFetch(
  responses: Array<{ status?: number; body?: any; throw?: Error }>,
) {
  let i = 0;
  const calls: string[] = [];
  const fn = (async (input: any) => {
    calls.push(typeof input === "string" ? input : input.toString());
    const next = responses[Math.min(i, responses.length - 1)];
    i++;
    if (next.throw) throw next.throw;
    return {
      ok: (next.status ?? 200) >= 200 && (next.status ?? 200) < 300,
      status: next.status ?? 200,
      json: async () => next.body ?? {},
    } as any;
  }) as unknown as typeof fetch;
  return { fn, calls: () => calls, count: () => i };
}

describe("Updater", () => {
  // Prevents: matched versions still triggering an update
  it("returns matched when hub version equals runner version", async () => {
    const { fn } = makeFetch([{ body: { version: "v1" } }]);
    let called = 0;
    const u = new Updater({
      hubBaseUrl: "http://hub.test",
      currentVersion: "v1",
      onUpdateNeeded: () => {
        called++;
      },
      fetchFn: fn,
    });
    assert.equal(await u.checkOnce(), "matched");
    assert.equal(called, 0);
  });

  // Prevents: missed update when hub bumps its version
  it("invokes onUpdateNeeded when hub version differs", async () => {
    const { fn } = makeFetch([{ body: { version: "v2" } }]);
    let received = "";
    const u = new Updater({
      hubBaseUrl: "http://hub.test",
      currentVersion: "v1",
      onUpdateNeeded: (v) => {
        received = v;
      },
      fetchFn: fn,
    });
    assert.equal(await u.checkOnce(), "update");
    assert.equal(received, "v2");
  });

  // Prevents: dev hub (no VERSION) triggering self-update against ""
  it("skips when hub version is empty", async () => {
    const { fn } = makeFetch([{ body: { version: "" } }]);
    let called = 0;
    const u = new Updater({
      hubBaseUrl: "http://hub.test",
      currentVersion: "v1",
      onUpdateNeeded: () => {
        called++;
      },
      fetchFn: fn,
    });
    assert.equal(await u.checkOnce(), "skipped");
    assert.equal(called, 0);
  });

  // Prevents: hub blip (network error) crashing the runner
  it("skips on fetch failure without throwing", async () => {
    const { fn } = makeFetch([{ throw: new Error("ECONNREFUSED") }]);
    const u = new Updater({
      hubBaseUrl: "http://hub.test",
      currentVersion: "v1",
      onUpdateNeeded: () => {
        assert.fail("update handler should not be called on fetch error");
      },
      fetchFn: fn,
    });
    assert.equal(await u.checkOnce(), "skipped");
  });

  // Prevents: 5xx from hub being treated as a version change
  it("skips on non-2xx response", async () => {
    const { fn } = makeFetch([{ status: 503, body: {} }]);
    const u = new Updater({
      hubBaseUrl: "http://hub.test",
      currentVersion: "v1",
      onUpdateNeeded: () => {
        assert.fail("update handler should not be called on 5xx");
      },
      fetchFn: fn,
    });
    assert.equal(await u.checkOnce(), "skipped");
  });

  // Prevents: start() crashing when local runner has no git checkout
  it("start() is a no-op when currentVersion is empty", () => {
    const u = new Updater({
      hubBaseUrl: "http://hub.test",
      currentVersion: "",
      onUpdateNeeded: () => {
        assert.fail("should never poll");
      },
      fetchFn: makeFetch([]).fn,
    });
    u.start();
    u.stop();
  });

  // Prevents: trailing slashes in hub URL producing //api/version
  it("normalizes trailing slashes in hub URL", async () => {
    const { fn, calls } = makeFetch([{ body: { version: "v1" } }]);
    const u = new Updater({
      hubBaseUrl: "http://hub.test/",
      currentVersion: "v1",
      onUpdateNeeded: () => {},
      fetchFn: fn,
    });
    await u.checkOnce();
    assert.equal(calls()[0], "http://hub.test/api/version");
  });
});
