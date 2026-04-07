#!/usr/bin/env node
import { Hub } from "./hub.ts";
import { HubDb } from "./db.ts";
import { AuthService } from "./auth.ts";

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[hub] invalid ${name}=${v}, using ${fallback}`);
    return fallback;
  }
  return n;
}

function envStr(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

const port = envInt("PORT", 3000);
const dbPath = envStr("HUB_DB_PATH", "./hub.db");
const version = envStr("VERSION", "");
const jwtSecret = process.env.JWT_SECRET;

if (!jwtSecret) {
  console.error(
    "[hub] FATAL: JWT_SECRET environment variable is required.\n" +
      "  Generate one with:  openssl rand -hex 32",
  );
  process.exit(1);
}
if (jwtSecret.length < 32) {
  console.error(
    "[hub] FATAL: JWT_SECRET must be at least 32 characters " +
      `(got ${jwtSecret.length}). Generate one with: openssl rand -hex 32`,
  );
  process.exit(1);
}

const db = new HubDb(dbPath);
const auth = new AuthService(db, jwtSecret);
const hub = new Hub({ port, db, auth, version });

await hub.start();
console.log(
  `[hub] listening on :${port} (db=${dbPath === ":memory:" ? "memory" : dbPath}, version=${version || "<unset>"})`,
);

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[hub] received ${signal}, shutting down...`);
  try {
    await hub.stop();
    db.close();
    console.log("[hub] stopped cleanly");
    process.exit(0);
  } catch (err) {
    console.error("[hub] error during shutdown:", err);
    process.exit(1);
  }
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
