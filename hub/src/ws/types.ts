/**
 * Per-connection context shared across the WebSocket handler modules
 * and any state stores that key on a connection. Extracted from hub.ts
 * so the state/ and ws/ modules can name them without depending on the
 * Hub class.
 */
import type { WebSocket } from "ws";

export interface ClientConnection {
  ws: WebSocket;
  accountId: string;
  email: string;
}

export interface RunnerConnection {
  ws: WebSocket;
  machineId: string;
  accountId: string;
  machineName: string;
}
