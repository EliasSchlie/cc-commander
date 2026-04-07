# Hub

A central server that all clients and machines connect to. There is one hub for all users.

## Responsibilities

- Manages user accounts (registration, login)
- Authenticates clients and machines
- Routes messages between clients and machines
- Stores session metadata (machine, directory, status, last activity, last message preview, lifecycle: `error_message`, `ended_at`, `archived_at`)
- Keeps session state in sync across all of a user's clients
- Soft-archives sessions on client request (the row stays for post-mortem queries but disappears from the live sidebar)

## What the hub does NOT do

- Run Claude Code sessions (that's the runner's job)
- Interpret or transform Claude SDK messages (it relays them)
- Store conversation history (that stays on the machine)
- Store API keys (the runner uses whatever credentials are on that machine)

## HTTP API

- `POST /api/auth/register` -- create an account, returns access + refresh tokens
- `POST /api/auth/login` -- exchange credentials for tokens
- `POST /api/auth/refresh` -- exchange a refresh token for a new pair
- `POST /api/machines` -- create a new machine for the authenticated account (Bearer token). Returns the registration token the runner uses to connect. Connected clients receive an updated `machine_list` over WebSocket.
- `GET /api/health`
- `GET /api/version` -- returns `{"version": "<sha>"}`. Runners poll this to detect that they need to self-update (see `runner/SPEC.md`).
- `GET /api/debug/state` -- authenticated runtime snapshot for the requester's account: hub uptime, runner/client connection counts, pending-history queue depth, memory, metrics, and `recentFailedSessions` (account-scoped, ordered by `ended_at`). Used by status tooling and Claude Code sessions doing post-mortem analysis without parsing logs.

## Client → Hub WebSocket messages

- `list_sessions` / `list_machines` -- bootstrap fetches
- `start_session` -- create a session on a machine; broadcasts updated `session_list`
- `send_prompt` -- forward a follow-up prompt into a running session
- `respond_to_prompt` -- answer a `user_prompt` (e.g. `AskUserQuestion`) the runner is blocked on
- `get_session_history` -- request a history snapshot from the runner; the hub forwards to the relevant runner with a TTL-bounded `requestId` and routes the reply back
- `archive_session` -- soft-delete: stamps `archived_at` so the row vanishes from `listSessionsForAccount` but stays available to `listFailedSessionsForAccount` and `/api/debug/state` for post-mortem. Account-scoped; cross-account ids return `Session not found`.

## Runner liveness

When a runner WebSocket disconnects, the hub marks any of that machine's
sessions in `running` or `waiting_for_input` as `error` (preview: "Runner
disconnected") and broadcasts the updated session list. This keeps the
client UI honest about which sessions are actually live.
