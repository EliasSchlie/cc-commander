/**
 * Tiny HTTP request helpers extracted from hub.ts so the routes/
 * modules can use them without depending on the Hub class. Pure
 * functions; no shared state.
 */
import type { IncomingMessage } from "node:http";

export const BEARER_PREFIX = "Bearer ";
export const MAX_BODY_BYTES = 1024 * 1024; // 1MB

/**
 * Best-effort client IP. Falls back to "unknown" so a missing socket
 * address still ends up rate-limited (under one shared bucket) instead
 * of bypassing the limiter entirely. Does NOT trust X-Forwarded-For:
 * the hub currently has no proxy-trust config, and trusting that header
 * unconditionally would let any caller spoof their bucket key.
 *
 * Normalizes IPv4-mapped IPv6 (::ffff:1.2.3.4 → 1.2.3.4) and IPv6
 * loopback (::1 → 127.0.0.1) so the same attacker connecting over
 * both stacks lands in the same bucket.
 */
export function clientIp(req: IncomingMessage): string {
  const raw = req.socket.remoteAddress ?? "unknown";
  if (raw.startsWith("::ffff:")) return raw.slice("::ffff:".length);
  if (raw === "::1") return "127.0.0.1";
  return raw;
}

export function extractBearerToken(req: IncomingMessage): string | null {
  const header = req.headers["authorization"];
  if (typeof header !== "string" || !header.startsWith(BEARER_PREFIX)) {
    return null;
  }
  return header.slice(BEARER_PREFIX.length);
}

/**
 * Read up to MAX_BODY_BYTES from the request and parse as JSON. Returns
 * `unknown` so callers must narrow before use; the routes that call this
 * destructure into known fields, which still typechecks under `any`-like
 * runtime shapes but flags genuine misreads at compile time.
 */
export function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: string | Buffer) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.byteLength;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}
