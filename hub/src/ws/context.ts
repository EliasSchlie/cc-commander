/**
 * Narrow context the WebSocket dispatch modules need from the Hub.
 * Defined as an interface so ws/{client,runner}Message.ts don't import
 * the Hub class directly -- one-way dependency, hub.ts builds the
 * context literal once per connection in handleConnection.
 *
 * Mirrors the routes/types.ts pattern: structural typing keeps Hub's
 * internals private while letting handlers stay testable with a
 * hand-rolled fake context.
 */
import type {
  HubToClientMsg,
  HubToRunnerMsg,
  MachineInfo,
} from "@cc-commander/protocol";
import type { Metrics } from "@cc-commander/protocol/metrics";
import type { HubDb } from "../db.ts";
import type { PendingHistoryStore } from "../state/pendingHistory.ts";
import type { ClientConnection, RunnerConnection } from "./types.ts";

export interface WsContext {
  db: HubDb;
  metrics: Metrics;
  pendingHistory: PendingHistoryStore;
  /** Live runner connections, keyed by machineId. Used by message
   *  dispatchers to find the runner for a session and to compute the
   *  online flag in machine listings. */
  runners: Map<string, RunnerConnection>;
  sendToClient(conn: ClientConnection, msg: HubToClientMsg): void;
  sendToRunner(conn: RunnerConnection, msg: HubToRunnerMsg): void;
  relayToClients(accountId: string, msg: HubToClientMsg): void;
  broadcastSessionList(accountId: string): void;
  broadcastMachineList(accountId: string): void;
  enrichedMachineList(accountId: string): MachineInfo[];
}
