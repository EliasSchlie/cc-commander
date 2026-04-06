# CC Commander -- Technical Design

> Implementation details for SPEC.md. This document is maintained by developers. SPEC.md is the source of truth for product requirements.

## Architecture

```
[iPhone] ---+                    +--- [MacBook runner]
[MacBook] --+--- Hub (VPS) -----+--- [VPS runner]
[Web]    ---+                    +--- [Mac Mini runner]
```

- **Clients** (left) connect to the hub over HTTPS/WSS
- **Runners** (right) connect outbound to the hub over WSS
- The hub routes messages between them
- No client ever talks directly to a runner
- The hub is a single central server shared by all users (multi-tenant)

## Repository Structure

Monorepo with independent components. Each component has its own dependencies, build, and tests. They share no runtime code -- they communicate only over the network.

```
cc-commander/
  SPEC.md                 # Product spec (source of truth)
  DESIGN.md               # Technical design
  hub/                    # Hub server (Node.js)
  runner/                 # Machine runner (Node.js)
  client/
    SPEC.md               # Shared client spec
    swift/                # iOS + macOS app (SwiftUI)
    web/                  # Browser client (later)
    cli/                  # CLI client (later)
```

Each component must:
- Have its own package manifest (`package.json`, `Package.swift`, etc.)
- Build independently
- Have its own tests that run independently
- Be deployable independently

## Components

### Runner (Node.js)

A small process that runs on each machine. It:
- Connects outbound to the hub via WebSocket
- Authenticates with a registration token (scoped to one account)
- Runs Claude Agent SDK `query()` calls on behalf of the user
- Streams SDK events to the hub
- Uses `bypassPermissions` + `canUseTool` so tools execute freely but user-interaction tools (AskUserQuestion, etc.) are relayed to the client

A machine can have multiple independent runner installs for different accounts. Each install has its own registration token and only sees its own sessions.

The runner is essentially the web UI prototype (`4b-web-ui-interactive.mjs` from claude-code-wrapper) adapted to talk to the hub instead of serving HTTP directly.

### Hub (Node.js)

A single central server that:
- Manages user accounts (registration, login)
- Authenticates clients (JWT) and runners (registration tokens)
- Maintains WebSocket connections to all connected runners and clients
- Routes messages: client -> runner (prompts, answers) and runner -> client (stream events)
- Stores session metadata in a database (which machine, directory, status, last activity, last message preview)
- Syncs session list to all connected clients for the same account
- Does NOT interpret Claude SDK messages -- it relays them opaquely
- Enforces account isolation: clients can only interact with runners registered to their account

### Client (SwiftUI)

A native iOS/macOS app using SwiftUI. Shared codebase with platform-specific layout:
- `NavigationSplitView` on macOS (sidebar + detail)
- `NavigationStack` on iOS (list -> detail)
- Connects to hub via WebSocket for real-time streaming
- REST API for session list, machine list, auth
- Local cache of session metadata for offline viewing of the list
- Session view: during generation, all content is expanded (tool calls, results). Once a turn completes, tool calls and results fold away. User can unfold any turn to see details.

## SDK Integration

The runner uses the Claude Agent SDK `query()` function:

```js
const options = {
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  includePartialMessages: true,
  canUseTool: async (toolName, input, opts) => {
    // Only fires for user-interaction tools (AskUserQuestion, etc.)
    // Execution tools are auto-approved by bypassPermissions.
    // Relay to hub -> client, wait for response, return result.
  },
};
```

Key properties:
- `bypassPermissions` handles all execution tools silently
- `canUseTool` only fires for user-interaction tools -- this is built into the SDK, not a filter we maintain
- For `AskUserQuestion`: return `{ behavior: "allow", updatedInput: { questions, answers } }`
- For unknown interaction tools: relay allow/deny to client

## Message Flow

### Client sends a prompt

```
Client --[WSS]--> Hub --[WSS]--> Runner
                                   |
                               query(prompt)
                                   |
                            SDK streams events
                                   |
Runner --[WSS]--> Hub --[WSS]--> Client(s)
```

### Claude asks a question (AskUserQuestion)

```
SDK fires canUseTool("AskUserQuestion", input)
  |
Runner --[WSS]--> Hub --[WSS]--> Client(s)
  |                                 |
  | (promise held)             User picks option
  |                                 |
Runner <--[WSS]-- Hub <--[WSS]-- Client
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

This powers the session picker on the client. Full conversation history stays on the machine (managed by the SDK).

## Security

- Hub listens on HTTPS only
- Runners connect outbound via WSS (no inbound ports needed)
- Machine registration: hub generates a one-time token scoped to an account, runner exchanges it for a persistent credential
- Client auth: email/password or OAuth -> JWT
- JWTs are short-lived with refresh tokens
- Runners only accept commands from the hub, never from clients directly
- The hub validates that a client's commands target runners belonging to their account
- Multiple accounts on the same machine are fully isolated (separate runner installs, separate credentials, separate sessions)

## Session History on Device Switch

When a client opens an existing session:
1. Hub sends session metadata (machine, directory, status)
2. Hub requests recent message history from the runner
3. Runner reads from SDK session storage (`getSessionMessages`)
4. Messages are relayed to the client
5. If the session is active, live streaming resumes

Clients don't store conversation history -- they fetch it on demand.
