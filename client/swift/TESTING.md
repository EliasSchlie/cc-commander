# Testing the Swift client

Two ways to drive the Swift client without a human at the keyboard:

1. **`ccc-shadow`** -- a headless SPM executable that uses the same
   `HubConnection` + `AppState` as the GUI app. Best for CI and protocol
   smoke tests.
2. **The GUI app under test mode** -- launch `CCCommander.app` with
   `CC_COMMANDER_CMD_FILE` set, then send commands from outside. Best
   when you want to verify SwiftUI bindings + the real `.task` startup
   path.

Both share `TestHarness` (in `CCApp`) so the surface is identical. A Claude
Code session interacts with one wire format regardless of which front-end
is running.

## Logging

`CCLog` always mirrors to `os.Logger` (subsystem `com.cc-commander.app`).
Set `LOG_FILE=/path/to/log` to also append a JSON-line record per call:

```
{"category":"HubConnection","component":"swift-client","level":"info","msg":"login complete, ws connected","ts":"..."}
```

| env var          | default          | meaning                                          |
|------------------|------------------|--------------------------------------------------|
| `LOG_FILE`       | (none)           | append JSON-line records here                    |
| `LOG_LEVEL`      | `info`           | `debug`/`info`/`warn`/`error`                    |
| `LOG_MAX_BYTES`  | `0` (no rotate)  | rotate to `LOG_FILE.1` when this size is reached |

If `LOG_FILE` is unset, the file sink is silent and only `os.Logger` runs.

## Command channel

When `CC_COMMANDER_CMD_FILE` is set, the harness watches that file for
JSON-line commands. Each line:

```json
{"id": "1", "cmd": "login", "args": {"email": "you@example.com", "password": "..."}}
```

The harness writes a response to `LOG_FILE` with the same `id`:

```json
{"kind":"harness_response","id":"1","cmd":"login","ok":true,"result":{"state":"connected"},"ts":"..."}
```

The runner truncates the command file on startup and emits a
`harness_ready` record before reading any lines, so the controller's
sequence is:

1. `tail -F $LOG_FILE` in one terminal
2. wait for `kind: harness_ready`
3. write commands one per line, append-only
4. for each command, watch for the matching `harness_response` line

### Commands

| `cmd`                   | required `args`                                      | result fields                                 |
|-------------------------|------------------------------------------------------|-----------------------------------------------|
| `login`                 | `email`, `password`                                  | `{state}`                                     |
| `connectStored`         | --                                                   | `{state}`                                     |
| `logout`                | --                                                   | `{state}`                                     |
| `startSession`          | `machineId`, `directory`, `prompt`                   | `{sessionId}`                                 |
| `selectSession`         | `sessionId`                                          | `{selectedSessionId}`                         |
| `sendPrompt`            | `prompt`                                             | `{sent}`                                      |
| `respondToPrompt`       | `promptId`, `response` (matches `UserPromptResponse` JSON encoding) | `{sent}`           |
| `waitForBootstrap`      | optional `timeout`                                   | `{machines, online, sessions}`                |
| `waitForSessionStatus`  | `sessionId`, optional `statuses` (default `["idle","error"]`), optional `timeout` | `{sessionId, status}` |
| `snapshot`              | --                                                   | full app state dictionary                     |
| `quit`                  | --                                                   | `{stopped}` (runner exits)                    |

### Validation

- `id` and `cmd` are both required and must be non-empty strings. A line with either missing returns `{"ok": false, "error": "missing or empty 'id'"}` (or `'cmd'`) immediately, without dispatching.
- A line that isn't a JSON object returns `{"ok": false, "error": "command line is not a JSON object", "raw": "..."}`.
- `args.timeout` accepts both JSON `Int` (e.g. `10`) and JSON `Double` (e.g. `10.5`); both round-trip via the `optionalDouble` helper.

### Diagnostic records

In addition to `harness_response`, the runner emits these to `LOG_FILE`:

| `kind`              | when                                                                                                |
|---------------------|-----------------------------------------------------------------------------------------------------|
| `harness_ready`     | After the command file is truncated on startup. Wait for this before writing commands.              |
| `harness_stopped`   | After a `quit` command, just before `runUntilQuit` returns.                                         |
| `harness_warning`   | External truncation reset (`previousOffset`/`newSize`), partial-line carry overflow (>1 MiB), or invalid UTF-8 in a line. |
| `harness_action`    | Each high-level harness method (login, startSession, …) logs its action arguments before executing. |
| `harness_result`    | Mirror of `harness_action` written when the action returns successfully.                            |

`snapshot` returns:

```json
{
  "isAuthenticated": true,
  "connectionState": "connected",
  "hasStoredCredentials": true,
  "machines": [{"machineId":"...","name":"...","online":true}, ...],
  "onlineMachineCount": 1,
  "sessions": [{"sessionId":"...","machineId":"...","directory":"...","status":"running","lastMessagePreview":""}, ...],
  "selectedSessionId": "...",
  "selectedSessionStream": {"entryCount":3,"status":"running","hasPendingPrompt":false,"pendingTextLen":42,"lastEntryKind":"toolCall"}
}
```

## Run the shadow client

```bash
cd client/swift/CCCommanderPackage
LOG_FILE=/tmp/ccc.log \
LOG_LEVEL=debug \
CC_COMMANDER_CMD_FILE=/tmp/ccc.cmd \
CC_COMMANDER_HUB=https://cc-commander.eliasschlie.com \
swift run ccc-shadow
```

In another terminal:

```bash
echo '{"id":"1","cmd":"login","args":{"email":"...","password":"..."}}' >> /tmp/ccc.cmd
echo '{"id":"2","cmd":"waitForBootstrap"}' >> /tmp/ccc.cmd
echo '{"id":"3","cmd":"snapshot"}' >> /tmp/ccc.cmd
echo '{"id":"4","cmd":"quit"}' >> /tmp/ccc.cmd
```

And tail:

```bash
tail -F /tmp/ccc.log | grep harness_response
```

### Legacy one-shot mode

`ccc-shadow` still supports the original env-var smoke test for back-compat
(used by CI scripts that pre-date the command channel):

```bash
CC_COMMANDER_TEST_EMAIL=... \
CC_COMMANDER_TEST_PASSWORD=... \
CC_COMMANDER_TEST_PROMPT='echo hi' \
swift run ccc-shadow
```

This logs in, waits for bootstrap, optionally drives one session to
completion, then exits 0/1.

## Run the GUI app under test mode

`xcodebuild build` produces `CCCommander.app`. Launch with:

```bash
LOG_FILE=/tmp/ccc-gui.log \
CC_COMMANDER_CMD_FILE=/tmp/ccc-gui.cmd \
open path/to/CCCommander.app --env LOG_FILE=... # or set via launchd plist for stability
```

Same command vocabulary. The GUI's `.task` hook routes through `TestHarness`
identically -- the only difference is that `RootView` is also rendered, so
SwiftUI bindings get exercised against the real state mutations.

## Unit tests

```bash
cd client/swift/CCCommanderPackage
swift test
```

CI runs this on every push. The Swift package tests cover:

- `CCModels` encoding/decoding
- `CCNetworking` `HubConnection` reconnect/auth flows (mocked)
- `CCApp` `AppState` message dispatch + `SessionStream` entry log
- `CCApp` `TestHarness` snapshot + `waitFor` timing semantics
- `CCLog` level enum sanity
