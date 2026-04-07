/**
 * Structured logger shared by hub and runner.
 *
 * No external deps -- builds on node:fs and process.stdout. Output is
 * JSON-per-line by default (machine-grep friendly) or pretty text in
 * TTYs / when LOG_FORMAT=text. Operators (and Claude Code sessions
 * debugging the app) get:
 *
 *   - Levels (debug/info/warn/error)
 *   - ISO8601 timestamps on every line
 *   - Stable component tag (`[hub]`, `[runner]`, ...)
 *   - Arbitrary structured fields via the second arg
 *   - Child loggers that bind context (sessionId, requestId, machineId)
 *     so a single grep reconstructs a full request trace
 *   - Optional file output with naive size-based rotation, set via
 *     LOG_FILE / LOG_MAX_BYTES / LOG_MAX_FILES env vars
 *
 * Why hand-rolled instead of pino: zero deps means the protocol package
 * stays a leaf in the workspace graph. Hub and runner both already
 * depend on it, so dropping the logger here is the cheapest place to
 * share. The feature surface is intentionally small -- if we ever need
 * sampling or transports, swap to pino at that point.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  renameSync,
  statSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogFields {
  [key: string]: unknown;
}

export interface LoggerOptions {
  /** Component tag, e.g. "hub", "runner", "updater". Required. */
  component: string;
  /** Minimum level to emit. Defaults to env LOG_LEVEL or "info". */
  level?: LogLevel;
  /** Pre-bound fields, merged into every log call. Used by child(). */
  bindings?: LogFields;
  /** Output sink. Defaults to a sink chosen from env vars. */
  sink?: LogSink;
}

export interface LogSink {
  write(line: string): void;
}

/**
 * stdout sink with optional pretty-printing for TTYs. JSON in non-TTY
 * (so Docker / journald / Loki get clean lines), human text otherwise.
 */
class ConsoleSink implements LogSink {
  private readonly pretty: boolean;
  constructor(pretty: boolean) {
    this.pretty = pretty;
  }
  write(line: string): void {
    if (this.pretty) {
      // line is JSON; reformat for human eyes
      try {
        const obj = JSON.parse(line) as Record<string, unknown>;
        const ts = String(obj.ts ?? "");
        const lvl = String(obj.level ?? "info")
          .toUpperCase()
          .padEnd(5);
        const comp = String(obj.component ?? "");
        const msg = String(obj.msg ?? "");
        const rest: Record<string, unknown> = {};
        for (const k of Object.keys(obj)) {
          if (k === "ts" || k === "level" || k === "component" || k === "msg")
            continue;
          rest[k] = obj[k];
        }
        const tail =
          Object.keys(rest).length > 0 ? " " + JSON.stringify(rest) : "";
        process.stdout.write(`${ts} ${lvl} [${comp}] ${msg}${tail}\n`);
        return;
      } catch {
        // fall through to raw write
      }
    }
    process.stdout.write(line + "\n");
  }
}

/**
 * Append-only file sink with naive size-based rotation. When the file
 * exceeds maxBytes, it's renamed to `.1`, `.1` to `.2`, etc., up to
 * maxFiles. Single-process only -- there's no fcntl coordination -- but
 * hub and runner are each one process, so good enough.
 */
class FileSink implements LogSink {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxFiles: number;
  private fd: number | null = null;
  private bytesWritten = 0;

  constructor(path: string, maxBytes: number, maxFiles: number) {
    this.path = path;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    mkdirSync(dirname(path), { recursive: true });
    this.open();
  }

  private open(): void {
    this.fd = openSync(this.path, "a");
    try {
      this.bytesWritten = statSync(this.path).size;
    } catch {
      this.bytesWritten = 0;
    }
  }

  private rotate(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* ignore */
      }
      this.fd = null;
    }
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const src = `${this.path}.${i}`;
      const dst = `${this.path}.${i + 1}`;
      if (existsSync(src)) {
        try {
          renameSync(src, dst);
        } catch {
          /* ignore */
        }
      }
    }
    if (existsSync(this.path)) {
      try {
        renameSync(this.path, `${this.path}.1`);
      } catch {
        /* ignore */
      }
    }
    this.open();
  }

  write(line: string): void {
    const buf = line + "\n";
    if (this.fd === null) return;
    try {
      writeSync(this.fd, buf);
      this.bytesWritten += Buffer.byteLength(buf);
      if (this.bytesWritten >= this.maxBytes) this.rotate();
    } catch {
      // Fallback so a broken file sink doesn't lose the line entirely.
      try {
        appendFileSync(this.path, buf);
      } catch {
        /* swallow -- last resort */
      }
    }
  }
}

class TeeSink implements LogSink {
  private readonly sinks: LogSink[];
  constructor(sinks: LogSink[]) {
    this.sinks = sinks;
  }
  write(line: string): void {
    for (const s of this.sinks) s.write(line);
  }
}

function envInt(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function envLevel(name: string): LogLevel | undefined {
  const v = process.env[name]?.toLowerCase();
  if (v === "debug" || v === "info" || v === "warn" || v === "error") return v;
  return undefined;
}

let cachedDefaultSink: LogSink | null = null;
function defaultSink(): LogSink {
  if (cachedDefaultSink) return cachedDefaultSink;
  const file = process.env.LOG_FILE;
  const formatEnv = process.env.LOG_FORMAT?.toLowerCase();
  const isTty = !!process.stdout.isTTY;
  // Pretty mode default: text in TTY, JSON elsewhere; LOG_FORMAT overrides.
  const pretty =
    formatEnv === "text" ? true : formatEnv === "json" ? false : isTty;
  const console = new ConsoleSink(pretty);
  if (file) {
    const maxBytes = envInt("LOG_MAX_BYTES", 10 * 1024 * 1024);
    const maxFiles = envInt("LOG_MAX_FILES", 5);
    try {
      const fileSink = new FileSink(file, maxBytes, maxFiles);
      cachedDefaultSink = new TeeSink([console, fileSink]);
      return cachedDefaultSink;
    } catch (err) {
      // Fall through to console-only; surface the failure once.
      process.stderr.write(
        `[logger] failed to open LOG_FILE=${file}: ${(err as Error).message}\n`,
      );
    }
  }
  cachedDefaultSink = console;
  return cachedDefaultSink;
}

/** Reset the cached sink. Used by tests; not for production. */
export function _resetLoggerSinkCache(): void {
  cachedDefaultSink = null;
}

export class Logger {
  private readonly component: string;
  private readonly level: LogLevel;
  private readonly bindings: LogFields;
  private readonly sink: LogSink;
  private readonly minRank: number;

  constructor(opts: LoggerOptions) {
    this.component = opts.component;
    this.level = opts.level ?? envLevel("LOG_LEVEL") ?? "info";
    this.bindings = opts.bindings ?? {};
    this.sink = opts.sink ?? defaultSink();
    this.minRank = LEVEL_RANK[this.level];
  }

  /** Returns a new logger with extra bindings merged in. */
  child(extra: LogFields): Logger {
    return new Logger({
      component: this.component,
      level: this.level,
      bindings: { ...this.bindings, ...extra },
      sink: this.sink,
    });
  }

  isLevelEnabled(level: LogLevel): boolean {
    return LEVEL_RANK[level] >= this.minRank;
  }

  debug(msg: string, fields?: LogFields): void {
    this.log("debug", msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.log("info", msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.log("warn", msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.log("error", msg, fields);
  }

  private log(level: LogLevel, msg: string, fields?: LogFields): void {
    if (LEVEL_RANK[level] < this.minRank) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      component: this.component,
      msg,
      ...this.bindings,
    };
    if (fields) {
      // Errors get expanded so the stack lands in the line.
      for (const k of Object.keys(fields)) {
        const v = fields[k];
        if (v instanceof Error) {
          record[k] = {
            message: v.message,
            name: v.name,
            stack: v.stack,
          };
        } else {
          record[k] = v;
        }
      }
    }
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch (err) {
      // Fallback if a binding is non-serializable (cycles, BigInt, ...).
      line = JSON.stringify({
        ts: record.ts,
        level,
        component: this.component,
        msg,
        serialize_error: (err as Error).message,
      });
    }
    try {
      this.sink.write(line);
    } catch {
      // Last-ditch -- never let logging crash the caller.
      try {
        process.stderr.write(line + "\n");
      } catch {
        /* swallow */
      }
    }
  }
}

/** Convenience: build a logger for a component using all env defaults. */
export function createLogger(component: string, bindings?: LogFields): Logger {
  return new Logger({ component, bindings });
}
