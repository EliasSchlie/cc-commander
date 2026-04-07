#!/usr/bin/env node
import { createLogger } from "@cc-commander/protocol/logger";
import { Hub } from "./hub.ts";
import { HubDb } from "./db.ts";
import { AuthService } from "./auth.ts";
import { runHubStatus } from "./status.ts";

const log = createLogger("hub");

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    log.warn("invalid env int, using fallback", {
      env: name,
      value: v,
      fallback,
    });
    return fallback;
  }
  return n;
}

function envStr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

// ── Subcommand dispatch ────────────────────────────────────────────────
//
// Default (no args) runs the hub. `status` is a debug entry point so a
// Claude Code session (or operator) can introspect a running hub.
// `--dry-run` validates env + DB without binding the listener -- useful
// for verifying a deployment before taking the port.

const sub = process.argv[2];

if (sub === "status") {
  // Best-effort introspection: assume the hub listens on $PORT locally
  // unless overridden via --url.
  const url =
    parseFlagValue("--url") ?? `http://localhost:${envInt("PORT", 3000)}`;
  await runHubStatus(url, log);
  process.exit(0);
}

const dryRun = hasFlag("--dry-run");

const port = envInt("PORT", 3000);
const dbPath = envStr("HUB_DB_PATH", "./hub.db");
const version = envStr("VERSION", "");
const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  log.error("FATAL: JWT_SECRET environment variable is required", {
    hint: "Generate one with: openssl rand -hex 32",
  });
  process.exit(1);
}
if (jwtSecret.length < 32) {
  log.error("FATAL: JWT_SECRET must be at least 32 characters", {
    got: jwtSecret.length,
    hint: "Generate one with: openssl rand -hex 32",
  });
  process.exit(1);
}

let db: HubDb;
try {
  db = new HubDb(dbPath);
} catch (err) {
  log.error("FATAL: cannot open database", {
    dbPath,
    err: err as Error,
    hint: "Check the path is writable and that no other hub process holds the file.",
  });
  process.exit(1);
}

if (dryRun) {
  // Validate-only mode: prove env + DB are usable, then exit 0 without
  // touching the network. Lets CC verify a hub is deployable before
  // taking the port.
  log.info("dry-run validation passed", {
    dbPath,
    port,
    version: version || null,
  });
  db.close();
  process.exit(0);
}

const auth = new AuthService(db, jwtSecret);
const startedAt = new Date().toISOString();
const hub = new Hub({ port, db, auth, version, startedAt });

try {
  await hub.start();
} catch (err) {
  const code = (err as NodeJS.ErrnoException).code;
  log.error("FATAL: cannot listen", {
    port,
    code: code ?? null,
    err: err as Error,
  });
  db.close();
  process.exit(1);
}

log.info("hub listening", {
  port,
  dbPath: dbPath === ":memory:" ? "memory" : dbPath,
  version: version || null,
  pid: process.pid,
  startedAt,
});

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info("shutdown begin", { signal });
  try {
    await hub.stop();
    db.close();
    log.info("shutdown complete");
    process.exit(0);
  } catch (err) {
    log.error("shutdown error", { err: err as Error });
    process.exit(1);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}
function parseFlagValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i < 0 || i === process.argv.length - 1) return undefined;
  return process.argv[i + 1];
}
