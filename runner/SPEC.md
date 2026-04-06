# Runner

A small process that runs on each machine where you want to run Claude Code sessions.

## How it works

- Connects outbound to the hub (no ports need to be opened on the machine)
- Registered to an account via a one-time token
- Runs Claude Code sessions using the Claude Agent SDK
- Streams session output to the hub, which relays it to clients
- Relays user-interaction requests (questions, etc.) to the hub, waits for responses from clients

## Configuration

There are two levels of configuration:

- **Machine-level:** set on the runner itself. Controls what the machine allows -- which directories are accessible, resource limits, environment variables. The person who sets up the machine controls these. Clients cannot override them.
- **Session-level:** sent by the client when starting a session. Controls how a specific session behaves -- which tools are available, max turns, max budget. These are per-task choices.

The runner merges both: session-level settings apply within the boundaries of machine-level settings.

## Account isolation

A machine can have multiple independent runner installs for different accounts. Each install has its own credentials and only sees its own sessions.

## Adding a machine

The app gives you a command to run on the machine. The runner registers with the hub and appears in the app.
