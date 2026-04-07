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

## Quickstart: drive `ccc-shadow` end-to-end

`ccc-shadow` is the headless executable. Fastest path to a working
script you can adapt:

```bash
cd client/swift/CCCommanderPackage

# Terminal A: launch the runner
LOG_FILE=/tmp/ccc.log \
CC_COMMANDER_CMD_FILE=/tmp/ccc.cmd \
CC_COMMANDER_HUB=https://cc-commander.eliasschlie.com \
swift run ccc-shadow

# Terminal B: tail responses
tail -F /tmp/ccc.log | grep harness_
```

```bash
# Terminal C: drive it. Wait for `harness_ready` in terminal B before writing.
cat <<'EOF' >> /tmp/ccc.cmd
{"id":"1","cmd":"login","args":{"email":"you@example.com","password":"secret"}}
{"id":"2","cmd":"waitForBootstrap","args":{"timeout":10}}
{"id":"3","cmd":"snapshot"}
{"id":"4","cmd":"quit"}
EOF
```

The poll interval is 100 ms, so a fresh command typically gets a
response within ~100–200 ms of being written.

## Quickstart: drive the real GUI app

Same command vocabulary. The GUI's `.task` hook routes through
`TestHarness` identically — the only difference is that SwiftUI is
rendering on top of the same state mutations, so layout / binding bugs
get exercised too.

```bash
# 1. Build it (no signing flags -- the project sets a stable team ID
#    so the macOS Keychain ACL on your stored JWT keeps matching).
cd client/swift
xcodebuild build \
  -project CCCommander.xcodeproj \
  -scheme CCCommander_macOS \
  -destination 'platform=macOS' \
  -quiet

# 2. Locate the built binary. Xcode puts it under DerivedData with
#    a hash that depends on the project file path -- this command
#    finds the most recent one.
APP=$(find ~/Library/Developer/Xcode/DerivedData \
        -path '*CCCommander*/Build/Products/Debug/CCCommander.app' \
        -maxdepth 6 2>/dev/null \
        | xargs -I {} stat -f '%m {}' {} \
        | sort -rn | head -1 | cut -d' ' -f2-)
echo "Using $APP"

# 3. Launch with the harness env vars. Run the executable directly --
#    `open` doesn't propagate env vars cleanly.
LOG_FILE=/tmp/ccc-gui.log \
CC_COMMANDER_CMD_FILE=/tmp/ccc-gui.cmd \
"$APP/Contents/MacOS/CCCommander" &

# 4. Drive it the same way as ccc-shadow.
tail -F /tmp/ccc-gui.log | grep harness_ &
cat <<'EOF' >> /tmp/ccc-gui.cmd
{"id":"1","cmd":"snapshot"}
{"id":"2","cmd":"waitForBootstrap","args":{"timeout":10}}
{"id":"3","cmd":"quit"}
EOF
```

If the app prompts you for a keychain password on launch, **stop** —
that means the binary's code signature changed since the JWT was
stored. Causes:
- The xcodeproj was regenerated without `DEVELOPMENT_TEAM` (project.yml
  must define it; CI is the only place that overrides it)
- An `xcodebuild` run passed `DEVELOPMENT_TEAM=` or `CODE_SIGN_IDENTITY=-`
  (don't do this locally — see `CLAUDE.md`)
- The cert in your login keychain expired and Xcode auto-issued a new one

`codesign -dvv "$APP" 2>&1 | grep TeamIdentifier` should print
`Q2U8K9N3BL`. If it prints `not set`, the binary is ad-hoc — rebuild
without the override flags.

## Worked example: full session round-trip

```bash
# Terminal A
cd client/swift/CCCommanderPackage
LOG_FILE=/tmp/ccc.log \
CC_COMMANDER_CMD_FILE=/tmp/ccc.cmd \
CC_COMMANDER_HUB=https://cc-commander.eliasschlie.com \
swift run ccc-shadow

# Terminal B
tail -F /tmp/ccc.log | grep harness_

# Terminal C — script the whole loop. Note the `id` on every line:
# response records carry the same id so you can match them deterministically.
cat <<'EOF' >> /tmp/ccc.cmd
{"id":"1","cmd":"login","args":{"email":"you@example.com","password":"secret"}}
{"id":"2","cmd":"waitForBootstrap","args":{"timeout":10}}
{"id":"3","cmd":"snapshot"}
{"id":"4","cmd":"startSession","args":{"machineId":"<from snapshot>","directory":"/Users/you/projects/foo","prompt":"Run the tests"}}
{"id":"5","cmd":"waitForSessionStatus","args":{"sessionId":"<from response 4>","statuses":["idle","error"],"timeout":120}}
{"id":"6","cmd":"snapshot"}
{"id":"7","cmd":"quit"}
EOF
```

`startSession` returns `{sessionId: "..."}` in its `result`, so a
real driver script reads that out of `harness_response` for `id:"4"`
and substitutes it into `id:"5"`'s args.

## Legacy env-var smoke test

`ccc-shadow` also accepts the original one-shot env-var harness for
manual smoke checks. It's a stripped-down version of the command
channel: log in, optionally drive one session to completion, exit 0/1.

```bash
CC_COMMANDER_TEST_EMAIL=... \
CC_COMMANDER_TEST_PASSWORD=... \
CC_COMMANDER_TEST_PROMPT='echo hi' \
CC_COMMANDER_TEST_DIR=/tmp \
swift run ccc-shadow
```

Use the command channel for anything beyond a single hello-world.

## Unit tests

```bash
cd client/swift/CCCommanderPackage
swift test
```

CI runs this on every push. Coverage:

- `CCModels` encoding/decoding
- `CCNetworking` `HubConnection` reconnect/auth flows (mocked)
- `CCApp` `AppState` message dispatch + `SessionStream` entry log
- `CCApp` `TestHarness` snapshot + `waitFor*` semantics
- `CCApp` `splitLines` chunk-boundary parsing (UTF-8 split, carry overflow + recovery, skip-mode)
- `CCLog` level enum + autoclosure laziness regression guard
