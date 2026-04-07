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
