# Hub

A central server that all clients and machines connect to. There is one hub for all users.

## Responsibilities

- Manages user accounts (registration, login)
- Authenticates clients and machines
- Routes messages between clients and machines
- Stores session metadata (machine, directory, status, last activity, last message preview)
- Keeps session state in sync across all of a user's clients

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

## Runner liveness

When a runner WebSocket disconnects, the hub marks any of that machine's
sessions in `running` or `waiting_for_input` as `error` (preview: "Runner
disconnected") and broadcasts the updated session list. This keeps the
client UI honest about which sessions are actually live.
