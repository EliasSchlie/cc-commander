# CC Commander -- Technical Design

> Implementation details for SPEC.md. This document is maintained by developers. SPEC.md is the source of truth for product requirements.

## Architecture

```
[iPhone] ---+                    +--- [MacBook agent]
[MacBook] --+--- Hub (VPS) -----+--- [VPS agent]
[Web]    ---+                    +--- [Mac Mini agent]
```

- **Devices** (left) connect to the hub over HTTPS/WSS
- **Machine agents** (right) connect outbound to the hub over WSS
- The hub routes messages between them
- No device ever talks directly to a machine
- The hub is a single central server shared by all users (multi-tenant)

## Components

### Machine Agent (Node.js)

A small process that runs on each machine. It:
- Connects outbound to the hub via WebSocket
- Authenticates with a registration token (scoped to one account)
- Runs Claude Agent SDK `query()` calls on behalf of the user
- Streams SDK events to the hub
- Uses `bypassPermissions` + `canUseTool` so tools execute freely but user-interaction tools (AskUserQuestion, etc.) are relayed to the device

A machine can have multiple independent agent installs for different accounts. Each install has its own registration token and only sees its own sessions.

The agent is essentially the web UI prototype (`4b-web-ui-interactive.mjs` from claude-code-wrapper) adapted to talk to the hub instead of serving HTTP directly.

### Hub (Node.js)

A single central server that:
- Manages user accounts (registration, login)
- Authenticates devices (JWT) and machines (registration tokens)
- Maintains WebSocket connections to all connected machines and devices
- Routes messages: device -> machine (prompts, answers) and machine -> device (stream events)
- Stores session metadata in a database (which machine, directory, status, last activity, last message preview)
- Syncs session list to all connected devices for the same account
- Does NOT interpret Claude SDK messages -- it relays them opaquely
- Enforces account isolation: devices can only interact with machines registered to their account

### Device App (SwiftUI)

A native iOS/macOS app using SwiftUI. Shared codebase with platform-specific layout:
- `NavigationSplitView` on macOS (sidebar + detail)
- `NavigationStack` on iOS (list -> detail)
- Connects to hub via WebSocket for real-time streaming
- REST API for session list, machine list, auth
- Local cache of session metadata for offline viewing of the list
- Session view: during generation, all content is expanded (tool calls, results). Once a turn completes, tool calls and results fold away. User can unfold any turn to see details.

## SDK Integration

The machine agent uses the Claude Agent SDK `query()` function:

```js
const options = {
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  includePartialMessages: true,
  canUseTool: async (toolName, input, opts) => {
    // Only fires for user-interaction tools (AskUserQuestion, etc.)
    // Execution tools are auto-approved by bypassPermissions.
    // Relay to hub -> device, wait for response, return result.
  },
};
```

Key properties:
- `bypassPermissions` handles all execution tools silently
- `canUseTool` only fires for user-interaction tools -- this is built into the SDK, not a filter we maintain
- For `AskUserQuestion`: return `{ behavior: "allow", updatedInput: { questions, answers } }`
- For unknown interaction tools: relay allow/deny to device

## Message Flow

### Device sends a prompt

```
Device --[WSS]--> Hub --[WSS]--> Machine Agent
                                      |
                                  query(prompt)
                                      |
                               SDK streams events
                                      |
Machine Agent --[WSS]--> Hub --[WSS]--> Device(s)
```

### Claude asks a question (AskUserQuestion)

```
SDK fires canUseTool("AskUserQuestion", input)
  |
Machine Agent --[WSS]--> Hub --[WSS]--> Device(s)
  |                                        |
  | (promise held)                    User picks option
  |                                        |
Machine Agent <--[WSS]-- Hub <--[WSS]-- Device
  |
canUseTool resolves with answers
  |
SDK continues
```

## Session Metadata

The hub stores lightweight metadata per session:

- Session ID (from SDK)
- Account ID
- Machine ID
- Directory
- Status (running / idle / waiting_for_input / error)
- Last activity timestamp
- Last message preview (truncated text)
- Created timestamp

This powers the session picker on the device. Full conversation history stays on the machine (managed by the SDK).

## Security

- Hub listens on HTTPS only
- Machine agents connect outbound via WSS (no inbound ports needed)
- Machine registration: hub generates a one-time token scoped to an account, agent exchanges it for a persistent credential
- Device auth: email/password or OAuth -> JWT
- JWTs are short-lived with refresh tokens
- Machine agents only accept commands from the hub, never from devices directly
- The hub validates that a device's commands target machines belonging to their account
- Multiple accounts on the same machine are fully isolated (separate agent installs, separate credentials, separate sessions)

## Session History on Device Switch

When a device opens an existing session:
1. Hub sends session metadata (machine, directory, status)
2. Hub requests recent message history from the machine agent
3. Machine agent reads from SDK session storage (`getSessionMessages`)
4. Messages are relayed to the device
5. If the session is active, live streaming resumes

Devices don't store conversation history -- they fetch it on demand.
