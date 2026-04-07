# Runner

A small process that runs on each machine where you want to run Claude Code sessions.

## How it works

- Connects outbound to the hub (no ports need to be opened on the machine)
- Registered to an account via a registration token (issued by the hub when the user adds the machine; persistent for the life of the install)
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

## Working directory validation

Every `start_session` carries a `directory`. Before invoking the SDK,
the runner validates that the path is:

- absolute (relative paths would silently resolve against the runner
  process cwd, which is rarely what the user intended)
- present on disk
- a directory (not a regular file)

A failed check is reported back to the client as a `session_error` with
a clear message (`Working directory does not exist: …` etc.) **before**
any `session_status: running` is broadcast, so a bad cwd doesn't flap
the session through running → error in the hub DB or client UI. Without
this check the SDK's own `chdir` failure surfaces as the misleading
"Claude Code executable not found at .../cli.js".

## Self-update

The runner polls `GET /api/version` on the hub every 5 minutes. When
the hub's `VERSION` (git SHA on `main` builds, tag name on `v*` builds)
no longer matches the runner's checked-out commit, the runner runs
`runner/scripts/update.sh` synchronously (`git fetch`, `git checkout`,
`npm ci`), exits cleanly, and launchd restarts it against the new code.
Logs land in `~/Library/Logs/cc-commander-runner-update.log`. See
[`DEPLOY.md`](../DEPLOY.md) for the operator-facing view.
