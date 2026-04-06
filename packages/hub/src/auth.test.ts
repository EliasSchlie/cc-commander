import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { HubDb } from "./db.ts";
import { AuthService } from "./auth.ts";

let db: HubDb;
let auth: AuthService;

beforeEach(() => {
  db = new HubDb(":memory:");
  auth = new AuthService(db, "test-secret-key-for-testing");
});

afterEach(() => {
  db.close();
});

describe("register", () => {
  // Prevents: registration succeeding without returning valid tokens
  it("registers a new account and returns tokens", async () => {
    const tokens = await auth.register("user@test.com", "password123");
    assert.ok(tokens.token);
    assert.ok(tokens.refreshToken);
  });

  // Prevents: duplicate registrations succeeding silently
  it("rejects duplicate email", async () => {
    await auth.register("user@test.com", "password123");
    await assert.rejects(
      () => auth.register("user@test.com", "other"),
      /already registered/,
    );
  });
});

describe("login", () => {
  // Prevents: login with correct credentials being rejected
  it("logs in with correct credentials", async () => {
    await auth.register("user@test.com", "password123");
    const tokens = await auth.login("user@test.com", "password123");
    assert.ok(tokens.token);
    assert.ok(tokens.refreshToken);
  });

  // Prevents: login with wrong password succeeding
  it("rejects wrong password", async () => {
    await auth.register("user@test.com", "password123");
    await assert.rejects(
      () => auth.login("user@test.com", "wrong"),
      /Invalid credentials/,
    );
  });

  // Prevents: login for non-existent account returning confusing error
  it("rejects unknown email", async () => {
    await assert.rejects(
      () => auth.login("nobody@test.com", "password123"),
      /Invalid credentials/,
    );
  });
});

describe("verifyToken", () => {
  // Prevents: valid JWTs being rejected
  it("verifies a valid token", async () => {
    const tokens = await auth.register("user@test.com", "password123");
    const payload = auth.verifyToken(tokens.token);
    assert.ok(payload.accountId);
    assert.equal(payload.email, "user@test.com");
  });

  // Prevents: tampered/invalid tokens being accepted
  it("rejects an invalid token", () => {
    assert.throws(() => auth.verifyToken("garbage-token"));
  });
});

describe("refresh", () => {
  // Prevents: valid refresh tokens not producing new token pairs
  it("issues new tokens from refresh token", async () => {
    const original = await auth.register("user@test.com", "password123");
    const refreshed = await auth.refresh(original.refreshToken);
    assert.ok(refreshed.token);
    assert.ok(refreshed.refreshToken);
    // Old refresh token should be invalidated (rotation)
    assert.notEqual(refreshed.refreshToken, original.refreshToken);
  });

  // Prevents: reused refresh tokens granting access (replay attack)
  it("invalidates old refresh token after use", async () => {
    const original = await auth.register("user@test.com", "password123");
    await auth.refresh(original.refreshToken);
    await assert.rejects(
      () => auth.refresh(original.refreshToken),
      /Invalid refresh token/,
    );
  });
});
