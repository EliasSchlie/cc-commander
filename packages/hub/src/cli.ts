#!/usr/bin/env node
import { HubDb } from "./db.ts";
import { AuthService } from "./auth.ts";
import { Hub } from "./hub.ts";

const PORT = parseInt(process.env.PORT || "8080", 10);
const DB_PATH = process.env.DB_PATH || "hub.db";
const JWT_SECRET = process.env.JWT_SECRET || "";

if (!JWT_SECRET) {
  console.error("Error: JWT_SECRET environment variable is required");
  process.exit(1);
}

const db = new HubDb(DB_PATH);
const auth = new AuthService(db, JWT_SECRET);
const hub = new Hub({ port: PORT, db, auth });

hub.start().then(() => {
  console.log(`CC Commander Hub running on port ${PORT}`);
  console.log(`Database: ${DB_PATH}`);
});

// Handle registration token creation via CLI argument
const command = process.argv[2];
if (command === "create-machine") {
  const accountEmail = process.argv[3];
  const machineName = process.argv[4];
  if (!accountEmail || !machineName) {
    console.error("Usage: hub create-machine <email> <machine-name>");
    process.exit(1);
  }
  const account = db.getAccountByEmail(accountEmail);
  if (!account) {
    console.error(`Account not found: ${accountEmail}`);
    process.exit(1);
  }
  const machine = db.createMachine(account.id, machineName);
  console.log(`Machine "${machineName}" created for ${accountEmail}`);
  console.log(`Registration token: ${machine.registrationToken}`);
  console.log(`\nRun this on the machine:`);
  console.log(
    `  CC_HUB_URL=ws://YOUR_HUB_HOST:${PORT} CC_TOKEN=${machine.registrationToken} cc-agent`,
  );
  db.close();
  process.exit(0);
}

process.on("SIGINT", async () => {
  console.log("\nShutting down...");
  await hub.stop();
  db.close();
  process.exit(0);
});
