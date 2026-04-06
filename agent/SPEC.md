# Agent

A small process that runs on each machine where you want to run Claude Code sessions.

## How it works

- Connects outbound to the hub (no ports need to be opened on the machine)
- Registered to an account via a one-time token
- Runs Claude Code sessions using the Claude Agent SDK
- Streams session output to the hub, which relays it to clients
- Relays user-interaction requests (questions, etc.) to the hub, waits for responses from clients

## Account isolation

A machine can have multiple independent agent installs for different accounts. Each install has its own credentials and only sees its own sessions.

## Adding a machine

The app gives you a command to run on the machine. The agent registers with the hub and appears in the app.
