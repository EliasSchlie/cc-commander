# Swift client -- agent notes

## Layout

```
client/swift/
  CCCommander/                       SwiftUI app target (macOS + iOS)
  CCCommanderPackage/                shared SPM workspace
    Sources/
      CCLog/                         JSON-line file sink + os.Logger mirror
      CCModels/                      protocol types (Codable)
      CCNetworking/                  HubConnection + WebSocket + auth
      CCApp/                         AppState, SessionStream, TestHarness, TestCommandRunner
      CCShadowClient/                ccc-shadow executable
    Tests/                           swift-testing suites
  project.yml                        XcodeGen input -- regenerate xcodeproj from this
```

## Build / test

Always work in `client/swift/CCCommanderPackage` for Swift Package commands;
use `client/swift` for Xcode project commands.

```bash
# Unit tests (fast, no hub required)
cd client/swift/CCCommanderPackage && swift test

# Build the headless driver
cd client/swift/CCCommanderPackage && swift build --product ccc-shadow

# Build the macOS app (CI uses this)
cd client/swift && xcodebuild build \
  -project CCCommander.xcodeproj \
  -scheme CCCommander_macOS \
  -destination 'platform=macOS' \
  CODE_SIGN_IDENTITY=- CODE_SIGNING_REQUIRED=NO CODE_SIGNING_ALLOWED=NO \
  -quiet
```

iOS is **not** built in CI -- macos-15 ships the iOS 18 SDK but no
simulator runtime, and downloading one is slow + flaky. Cross-platform
code is exercised by `swift test`; iOS-specific code is a small set of
SwiftUI `#if os(iOS)` blocks.

## Verifying changes end-to-end

You can drive the real app (or `ccc-shadow`) without a human. See
[`TESTING.md`](TESTING.md) for the wire format. TL;DR:

```bash
LOG_FILE=/tmp/ccc.log \
CC_COMMANDER_CMD_FILE=/tmp/ccc.cmd \
CC_COMMANDER_HUB=https://cc-commander.eliasschlie.com \
swift run ccc-shadow
```

then write JSON-line commands to `/tmp/ccc.cmd` and tail `/tmp/ccc.log`
for matching `harness_response` records. Use `cmd: "snapshot"` to assert
on the full app state instead of grepping individual log lines.

## Logging conventions

- Always use `CCLog.{debug,info,warn,error}(category, msg, fields)` --
  never raw `print()` and never `os.Logger` directly. CCLog mirrors to
  both, so a single `LOG_FILE` captures every layer.
- `category` is the type name (e.g. `"HubConnection"`, `"AppState"`).
- `fields` are typed (`.string/.int/.double/.bool`); stringify rich
  values with `String(describing:)` at the call site.
- For test-harness records (action / result / response), use
  `CCLog.emitRecord([...])` directly so they bypass the level filter.

## Don't

- Don't edit `CCCommander.xcodeproj` by hand -- regenerate from
  `project.yml` via XcodeGen.
- Don't add new `Logger(...)` instances. Use the `CCLog` wrapper.
- Don't add bespoke env-var test hooks in the SwiftUI app -- extend
  `TestHarness` / `TestCommandRunner` instead so both the GUI and the
  shadow client get the new capability for free.
- Don't sleep-then-snapshot in tests. Use `harness.waitFor { ... }` so
  failures are deterministic.
