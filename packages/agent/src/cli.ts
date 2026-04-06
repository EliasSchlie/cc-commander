#!/usr/bin/env node
import { MachineAgent } from "./agent.ts";

const HUB_URL = process.env.CC_HUB_URL || "";
const TOKEN = process.env.CC_TOKEN || "";
const MACHINE_NAME =
  process.env.CC_MACHINE_NAME || (await import("node:os")).hostname();

if (!HUB_URL) {
  console.error("Error: CC_HUB_URL environment variable is required");
  console.error("  Example: CC_HUB_URL=ws://hub.example.com:8080");
  process.exit(1);
}

if (!TOKEN) {
  console.error("Error: CC_TOKEN environment variable is required");
  console.error("  Get a token from the CC Commander app or hub admin");
  process.exit(1);
}

const agent = new MachineAgent({
  hubUrl: HUB_URL,
  registrationToken: TOKEN,
  machineName: MACHINE_NAME,
});

console.log(`CC Commander Agent starting...`);
console.log(`  Hub: ${HUB_URL}`);
console.log(`  Machine: ${MACHINE_NAME}`);

agent
  .connect()
  .then(() => {
    console.log("Connected. Waiting for commands...");
  })
  .catch((err) => {
    console.error("Failed to connect:", err.message);
    process.exit(1);
  });

process.on("SIGINT", () => {
  console.log("\nShutting down...");
  agent.disconnect();
  process.exit(0);
});
