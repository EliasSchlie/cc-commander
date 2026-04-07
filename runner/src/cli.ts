#!/usr/bin/env node
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, hostname } from "node:os";
import { createLogger } from "@cc-commander/protocol/logger";
import { MachineRunner } from "./runner.ts";
import { Updater } from "./updater.ts";

const log = createLogger("runner");

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
    log.error("no config", {
      path,
      hint: "Run `cc-commander-runner register --hub <url> --email <email> --name <name>`",
    });
    process.exit(1);
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    log.error("failed to read config", { path, err: err as Error });
    process.exit(1);
  }
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    log.error("config is not valid JSON", { path, err: err as Error });
    process.exit(1);
  }
  for (const key of ["hubUrl", "registrationToken", "machineName"] as const) {
    if (typeof parsed[key] !== "string" || !parsed[key]) {
      log.error("config missing required string field", { key });
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
    log.error(
      "usage: register --hub <url> --email <email> [--name <name>] [--password <pw>] [--config <path>]",
    );
    process.exit(1);
  }
  if (!hubUrl.startsWith("http://") && !hubUrl.startsWith("https://")) {
    log.error("--hub must be an http(s) URL", { hubUrl });
    process.exit(1);
  }

  const password = passwordArg ?? (await readPasswordFromTty("Hub password: "));
  if (!password) {
    log.error("password required");
    process.exit(1);
  }

  log.info("logging in", { hubUrl, email });
  const login = await postJson(`${hubUrl}/api/auth/login`, { email, password });
  if (login.status !== 200 || !login.data?.token) {
    log.error("login failed", {
      status: login.status,
      error: login.data?.error ?? "unknown",
    });
    process.exit(1);
  }
  const jwt = login.data.token as string;

  log.info("creating machine", { name });
  const create = await postJson(
    `${hubUrl}/api/machines`,
    { name },
    { Authorization: `Bearer ${jwt}` },
  );
  if (create.status !== 201 || !create.data?.registrationToken) {
    log.error("machine create failed", {
      status: create.status,
      error: create.data?.error ?? "unknown",
    });
    process.exit(1);
  }

  const cfg: RunnerFileConfig = {
    hubUrl: swapWsHttp(hubUrl, "ws"),
    registrationToken: create.data.registrationToken,
    machineName: name,
  };
  writeConfig(configPath, cfg);
  log.info("wrote config", { configPath, machineId: create.data.machineId });
  log.info("start the runner with: cc-commander-runner run");
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
    log.warn("could not detect git version; self-update disabled", {
      error: result.error.message,
    });
    return "";
  }
  if (result.status !== 0) {
    log.warn("git rev-parse failed; self-update disabled", {
      status: result.status,
    });
    return "";
  }
  return result.stdout.trim();
}

async function cmdRun(flags: Record<string, string | boolean>): Promise<void> {
  const configPath = String(flags.config ?? DEFAULT_CONFIG_PATH);
  const cfg = readConfig(configPath);
  const currentVersion = detectRunnerVersion();
  const dryRun = !!flags["dry-run"];
  if (dryRun) {
    // Validate-only mode: prove config + hub reachability, then exit.
    // Lets a Claude Code session verify a runner is correctly set up
    // before launching the long-lived process under launchd.
    log.info("dry-run: validating config and hub reachability", {
      configPath,
      machineName: cfg.machineName,
      hubUrl: cfg.hubUrl,
      version: currentVersion || null,
    });
    const httpUrl = swapWsHttp(cfg.hubUrl, "http");
    try {
      const res = await fetch(`${httpUrl}/api/health`);
      log.info("hub reachable", { status: res.status });
    } catch (err) {
      log.error("hub unreachable", { url: httpUrl, err: err as Error });
      process.exit(1);
    }
    log.info("dry-run validation passed");
    process.exit(0);
  }
  log.info("starting runner", {
    machineName: cfg.machineName,
    hubUrl: cfg.hubUrl,
    configPath,
    version: currentVersion || null,
  });
  const runner = new MachineRunner({
    hubUrl: cfg.hubUrl,
    registrationToken: cfg.registrationToken,
    machineName: cfg.machineName,
  });

  // Tracked so shutdown() can clear it. Without this, a Ctrl-C during the
  // 5s reconnect window leaves a connect() pending after disconnect().
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  // Cooldown marker written by update.sh on failure. If present and
  // recent, we skip the self-update path entirely so a broken update
  // (network blip, npm ci failure) does not turn launchd KeepAlive into
  // a 30-second-interval restart loop.
  const updateFailureMarker = join(
    RUNNER_REPO_DIR,
    ".cc-commander-update-failure",
  );
  const UPDATE_COOLDOWN_MS = 30 * 60 * 1000; // 30 min

  function shouldSkipUpdate(): boolean {
    try {
      const st = statSync(updateFailureMarker);
      const ageMs = Date.now() - st.mtimeMs;
      if (ageMs < UPDATE_COOLDOWN_MS) {
        const minsLeft = Math.ceil((UPDATE_COOLDOWN_MS - ageMs) / 60000);
        log.warn("previous update failed; in cooldown", {
          agoMin: Math.floor(ageMs / 60000),
          coolingDownMin: minsLeft,
          marker: updateFailureMarker,
        });
        return true;
      }
    } catch {
      // marker missing → no recent failure, proceed normally
    }
    return false;
  }

  // onUpdateNeeded runs update.sh SYNCHRONOUSLY before exiting. The
  // previous detached-spawn pattern raced launchd's KeepAlive restart
  // and caused the new runner process to read the OLD git tree before
  // update.sh's checkout landed (see PR #65 for the full timeline).
  // Running synchronously means the parent runner is still alive --
  // and holding the launchd "process is up" state -- while git
  // checkout + npm ci complete. Only after they finish does the
  // runner exit, and only then does launchd boot the replacement,
  // guaranteed against the new tree.
  const updater = new Updater({
    hubBaseUrl: swapWsHttp(cfg.hubUrl, "http"),
    currentVersion,
    pollIntervalMs:
      parseInt(process.env.CC_COMMANDER_POLL_MS ?? "", 10) || undefined,
    onUpdateNeeded: (hubVersion) => {
      if (shouldSkipUpdate()) return;

      const script = join(RUNNER_REPO_DIR, "scripts", "update.sh");
      log.info("running update script (sync)", { script, hubVersion });
      // CRITICAL: do not call runner.disconnect() before spawnSync.
      // disconnect() flips shouldReconnect=false permanently, so on
      // an update failure (return path below) the runner would stay
      // alive without a hub connection -- a zombie that launchd
      // never restarts. Disconnect ONLY on the success path,
      // immediately before process.exit, so any failure leaves the
      // runner intact and connected on the OLD tree.
      //
      // Side effect: spawnSync blocks the event loop for the
      // duration of the update (~2-5s typical, longer on cold npm
      // ci), so the WS heartbeat doesn't run. If the heartbeat
      // window trips, the hub will see the runner go away briefly
      // and mark in-flight sessions as errored -- same end state as
      // an explicit disconnect, no worse.
      const result = spawnSync("/bin/sh", [script, hubVersion], {
        cwd: RUNNER_REPO_DIR,
        // Inherit stdio so update.sh's npm ci output streams to the
        // launchd stdout/err log alongside the runner's structured
        // logs -- a single tail captures both halves of an update.
        stdio: "inherit",
      });
      if (result.error) {
        log.error("failed to spawn update script", {
          err: result.error,
        });
        // Runner stays up on OLD tree and OLD hub connection. The
        // failure marker (written by update.sh on its own failures)
        // blocks retries during the cooldown window.
        return;
      }
      if (result.status !== 0) {
        log.error("update script exited non-zero", {
          status: result.status,
          signal: result.signal ?? null,
        });
        return;
      }
      log.info("update script complete; exiting for launchd restart", {
        hubVersion,
      });
      runner.disconnect();
      process.exit(0);
    },
  });

  let shuttingDown = false;
  function shutdown(signal: string): void {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("shutdown begin", { signal });
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
    log.error("initial connect failed", { err: err as Error });
    log.warn("will retry in 5s");
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      runner
        .connect()
        .catch((e) => log.error("reconnect failed", { err: e as Error }));
    }, 5000);
  }

  updater.start();
}

/**
 * `cc-commander-runner status` -- prints the resolved config, the
 * detected runner version, hub reachability, and (if a JWT is in
 * $HUB_DEBUG_TOKEN) the hub's /api/debug/state slice for this runner's
 * machineId. Designed so a Claude Code session can answer "is this
 * runner registered, can it reach the hub, what's the hub seeing"
 * without having to start the long-lived process.
 */
async function cmdStatus(
  flags: Record<string, string | boolean>,
): Promise<void> {
  // readConfig handles the missing-file case (and TOCTOU): no need
  // for a redundant existsSync probe before it.
  const configPath = String(flags.config ?? DEFAULT_CONFIG_PATH);
  const cfg = readConfig(configPath);
  const currentVersion = detectRunnerVersion();
  log.info("runner config", {
    configPath,
    machineName: cfg.machineName,
    hubUrl: cfg.hubUrl,
    version: currentVersion || null,
    pid: process.pid,
  });
  const httpUrl = swapWsHttp(cfg.hubUrl, "http");
  try {
    const res = await fetch(`${httpUrl}/api/health`);
    log.info("hub health", {
      url: `${httpUrl}/api/health`,
      status: res.status,
    });
  } catch (err) {
    log.error("hub health unreachable", { url: httpUrl, err: err as Error });
  }
  try {
    const res = await fetch(`${httpUrl}/api/version`);
    const text = await res.text();
    log.info("hub version", { status: res.status, body: text });
  } catch (err) {
    log.error("hub version unreachable", { err: err as Error });
  }
  const debugToken = process.env.HUB_DEBUG_TOKEN;
  if (debugToken) {
    try {
      const res = await fetch(`${httpUrl}/api/debug/state`, {
        headers: { Authorization: `Bearer ${debugToken}` },
      });
      const text = await res.text();
      log.info("hub debug state", {
        status: res.status,
        body: text.slice(0, 4000),
      });
    } catch (err) {
      log.error("hub debug state failed", { err: err as Error });
    }
  } else {
    log.info("debug state skipped", {
      hint: "set HUB_DEBUG_TOKEN to a valid JWT to fetch /api/debug/state",
    });
  }
}

function usage(): void {
  // Plain stdout (not the structured logger): humans run --help.
  process.stdout.write(
    [
      "cc-commander-runner — runs Claude Code sessions on this machine",
      "",
      "Commands:",
      "  register --hub <url> --email <email> [--name <name>] [--password <pw>] [--config <path>]",
      "      Log into the hub and create a machine; writes config file with the registration token.",
      "  run [--config <path>] [--dry-run]",
      "      Connect to the hub and serve sessions. Reconnects on disconnect.",
      "      --dry-run validates config + hub reachability and exits 0 without serving.",
      "  status [--config <path>]",
      "      Print resolved config, runner version, and hub /health + /version.",
      "      Set HUB_DEBUG_TOKEN to also fetch /api/debug/state.",
      "",
      `Default config path: ${DEFAULT_CONFIG_PATH}`,
      "Override with --config or the CC_COMMANDER_CONFIG env var.",
      "",
      "Logging env vars (shared with hub):",
      "  LOG_LEVEL=debug|info|warn|error  (default: info)",
      "  LOG_FORMAT=json|text             (default: text in TTY, json otherwise)",
      "  LOG_FILE=<path>                  (also tee logs to a rotating file)",
      "  LOG_MAX_BYTES=<n>                (rotation threshold, default 10MB)",
      "  LOG_MAX_FILES=<n>                (rotation depth, default 5)",
      "",
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
} else if (sub === "status") {
  await cmdStatus(flags);
} else {
  log.error("unknown command", { sub });
  usage();
  process.exit(1);
}
