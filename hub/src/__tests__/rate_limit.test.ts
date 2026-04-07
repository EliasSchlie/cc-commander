import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TokenBucketRateLimiter } from "../rate_limit.ts";

describe("TokenBucketRateLimiter", () => {
  // Prevents: rate limiter blocking the very first request
  it("allows the first `capacity` requests in a burst", () => {
    let now = 0;
    const rl = new TokenBucketRateLimiter(
      { capacity: 3, refillPerMs: 0.0001 },
      () => now,
    );
    assert.equal(rl.tryConsume("ip"), true);
    assert.equal(rl.tryConsume("ip"), true);
    assert.equal(rl.tryConsume("ip"), true);
    assert.equal(rl.tryConsume("ip"), false);
  });

  // Prevents: tokens never refilling, locking out a key forever
  it("refills tokens over time", () => {
    let now = 0;
    // 1 token per 1000ms
    const rl = new TokenBucketRateLimiter(
      { capacity: 2, refillPerMs: 1 / 1000 },
      () => now,
    );
    assert.equal(rl.tryConsume("ip"), true);
    assert.equal(rl.tryConsume("ip"), true);
    assert.equal(rl.tryConsume("ip"), false);
    now = 1000;
    assert.equal(rl.tryConsume("ip"), true);
    assert.equal(rl.tryConsume("ip"), false);
  });

  // Prevents: one abusive IP exhausting the bucket for everyone
  it("isolates buckets per key", () => {
    let now = 0;
    const rl = new TokenBucketRateLimiter(
      { capacity: 1, refillPerMs: 0.0001 },
      () => now,
    );
    assert.equal(rl.tryConsume("ip-a"), true);
    assert.equal(rl.tryConsume("ip-a"), false);
    assert.equal(rl.tryConsume("ip-b"), true);
  });

  // Prevents: bucket map growing without bound under attack
  it("sweep evicts fully-refilled buckets", () => {
    let now = 0;
    // capacity 2, 1 token per 1000ms -> full refill in 2000ms
    const rl = new TokenBucketRateLimiter(
      { capacity: 2, refillPerMs: 1 / 1000 },
      () => now,
    );
    rl.tryConsume("ip-a");
    rl.tryConsume("ip-b");
    assert.equal(rl.size(), 2);
    now = 2000;
    rl.sweep();
    assert.equal(rl.size(), 0);
  });
});
