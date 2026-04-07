#!/usr/bin/env node
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";
import { MachineRunner } from "./runner.ts";
import { Updater } from "./updater.ts";

interface RunnerFileConfig {
  hubUrl: string;
  registrationToken: string;
  machineName: string;
}

const DEFAULT_CONFIG_PATH =
  process.env.CC_COMMANDER_CONFIG ??
  join(homedir(), ".config", "cc-commander", "runner.json");

function readConfig(path: string): RunnerFileConfig {
  if (!existsSync(path)) {
    console.error(
      `[runner] no config at ${path}\n` +
        `  Run:  cc-commander-runner register --hub <url> --email <you@example.com> --name <machine-name>\n` +
        `  Or write the file by hand: { "hubUrl": "...", "registrationToken": "...", "machineName": "..." }`,
    );
    process.exit(1);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    console.error(`[runner] failed to read ${path}: ${(err as Error).message}`);
    process.exit(1);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error(
      `[runner] config is not valid JSON: ${(err as Error).message}`,
    );
    process.exit(1);
  }
  for (const key of ["hubUrl", "registrationToken", "machineName"] as const) {
    if (typeof parsed[key] !== "string" || !parsed[key]) {
      console.error(`[runner] config missing required string field: ${key}`);
      process.exit(1);
    }
  }
  return parsed;
}

function writeConfig(path: string, cfg: RunnerFileConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 });
}

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
    } else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

async function postJson(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; data: any }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  let data: any = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }
  }
  return { status: res.status, data };
}

async function readPasswordFromTty(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.once("data", (d) => {
      process.stdin.pause();
      resolve(d.toString().replace(/\r?\n$/, ""));
    });
  });
}

async function cmdRegister(
  flags: Record<string, string | boolean>,
): Promise<void> {
  const hubUrl = String(flags.hub ?? flags.h ?? "");
  const email = String(flags.email ?? "");
  const name = String(flags.name ?? hostname());
  const passwordArg = flags.password ? String(flags.password) : null;
  const configPath = String(flags.config ?? DEFAULT_CONFIG_PATH);

  if (!hubUrl || !email) {
    console.error(
      "Usage: cc-commander-runner register --hub <https://hub.example.com> --email <you@example.com> [--name <machine-name>] [--password <pw>] [--config <path>]",
    );
    process.exit(1);
  }
  if (!hubUrl.startsWith("http://") && !hubUrl.startsWith("https://")) {
    console.error("[runner] --hub must be an http(s) URL");
    process.exit(1);
  }

  const password = passwordArg ?? (await readPasswordFromTty("Hub password: "));
  if (!password) {
    console.error("[runner] password required");
    process.exit(1);
  }

  console.log(`[runner] logging in to ${hubUrl} as ${email}...`);
  const login = await postJson(`${hubUrl}/api/auth/login`, { email, password });
  if (login.status !== 200 || !login.data?.token) {
    console.error(
      `[runner] login failed (HTTP ${login.status}): ${login.data?.error ?? "unknown"}`,
    );
    process.exit(1);
  }
  const jwt = login.data.token as string;

  console.log(`[runner] creating machine "${name}"...`);
  const create = await postJson(
    `${hubUrl}/api/machines`,
    { name },
    { Authorization: `Bearer ${jwt}` },
  );
  if (create.status !== 201 || !create.data?.registrationToken) {
    console.error(
      `[runner] machine create failed (HTTP ${create.status}): ${create.data?.error ?? "unknown"}`,
    );
    process.exit(1);
  }

  const cfg: RunnerFileConfig = {
    hubUrl: swapWsHttp(hubUrl, "ws"),
    registrationToken: create.data.registrationToken,
    machineName: name,
  };
  writeConfig(configPath, cfg);
  console.log(`[runner] wrote ${configPath}`);
  console.log(`[runner] machineId=${create.data.machineId}`);
  console.log(`[runner] start the runner with:  cc-commander-runner run`);
}

// src/cli.ts → src → runner
const RUNNER_REPO_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** Swap ws[s]:// for http[s]:// (or vice versa) on the same host. */
function swapWsHttp(url: string, target: "ws" | "http"): string {
  const u = new URL(url);
  const secure = u.protocol === "https:" || u.protocol === "wss:";
  u.protocol =
    target === "ws" ? (secure ? "wss:" : "ws:") : secure ? "https:" : "http:";
  return u.toString().replace(/\/$/, "");
}

/**
 * Returns the runner's current git commit SHA, or "" if it can't be
 * determined (no git, not a checkout, etc.). Used by the updater to
 * compare against the hub's /api/version.
 *
 * Override with CC_COMMANDER_RUNNER_VERSION for testing.
 */
function detectRunnerVersion(): string {
  const override = process.env.CC_COMMANDER_RUNNER_VERSION;
  if (override) return override;
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: RUNNER_REPO_DIR,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error) {
    console.warn(
      `[runner] could not detect git version (${result.error.message}); self-update disabled`,
    );
    return "";
  }
  if (result.status !== 0) {
    console.warn(
      `[runner] git rev-parse exited ${result.status}; self-update disabled`,
    );
    return "";
  }
  return result.stdout.trim();
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<void> {
  const configPath = String(flags.config ?? DEFAULT_CONFIG_PATH);
  const cfg = readConfig(configPath);
  const currentVersion = detectRunnerVersion();
  console.log(
    `[runner] starting "${cfg.machineName}" → ${cfg.hubUrl} (config=${configPath}, version=${currentVersion || "<unknown>"})`,
  );
  const runner = new MachineRunner({
    hubUrl: cfg.hubUrl,
    registrationToken: cfg.registrationToken,
    machineName: cfg.machineName,
  });

  // Tracked so shutdown() can clear it. Without this, a Ctrl-C during the
  // 5s reconnect window leaves a connect() pending after disconnect().
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // onUpdateNeeded fires the spawn + exit; needs `updater` declared first
  // to keep it on its own (never re-entered).
  const updater = new Updater({
    hubBaseUrl: swapWsHttp(cfg.hubUrl, "http"),
    currentVersion,
    pollIntervalMs:
      parseInt(process.env.CC_COMMANDER_POLL_MS ?? "", 10) || undefined,
    onUpdateNeeded: (hubVersion) => {
      const script = join(RUNNER_REPO_DIR, "scripts", "update.sh");
      console.log(`[updater] running ${script} → ${hubVersion}`);
      const child = spawn("/bin/sh", [script, hubVersion], {
        cwd: RUNNER_REPO_DIR,
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (err) => {
        console.error(
          `[updater] failed to spawn update script: ${err.message}`,
        );
      });
      child.unref();
      console.log("[updater] exiting for launchd restart");
      runner.disconnect();
      process.exit(0);
    },
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[runner] received ${signal}, shutting down...`);
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    updater.stop();
    runner.disconnect();
    setTimeout(() => process.exit(0), 100);
  }
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  try {
    await runner.connect();
  } catch (err) {
    console.error(`[runner] initial connect failed: ${String(err)}`);
    console.error("[runner] will retry in 5s...");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      runner.connect().catch((e) => console.error(String(e)));
    }, 5000);
  }

  updater.start();
}

function usage(): void {
  console.log(
    [
      "cc-commander-runner — runs Claude Code sessions on this machine",
      "",
      "Commands:",
      "  register --hub <url> --email <email> [--name <name>] [--password <pw>] [--config <path>]",
      "      Log into the hub and create a machine; writes config file with the registration token.",
      "  run [--config <path>]",
      "      Connect to the hub and serve sessions. Reconnects on disconnect.",
      "",
      `Default config path: ${DEFAULT_CONFIG_PATH}`,
      "Override with --config or the CC_COMMANDER_CONFIG env var.",
    ].join("\n"),
  );
}

const argv = process.argv.slice(2);
const sub = argv[0];
const flags = parseFlags(argv.slice(1));

if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
  usage();
  process.exit(sub ? 0 : 1);
} else if (sub === "register") {
  await cmdRegister(flags);
} else if (sub === "run") {
  await cmdRun(flags);
} else {
  console.error(`Unknown command: ${sub}`);
  usage();
  process.exit(1);
}
