#!/usr/bin/env bash
# Install the cc-commander runner as a launchd agent on macOS.
#
# Prereqs:
#   - You have run `npm install` in ../runner (so node_modules is populated).
#   - You have already run `node --experimental-strip-types ../src/cli.ts register ...`
#     so that ~/.config/cc-commander/runner.json exists.
#
# Run from the runner/launchd directory:  ./install.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RUNNER_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
PLIST_LABEL="com.cc-commander.runner"
TARGET_PLIST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"
TEMPLATE="$SCRIPT_DIR/$PLIST_LABEL.plist"
CONFIG_PATH="${CC_COMMANDER_CONFIG:-$HOME/.config/cc-commander/runner.json}"

if [[ ! -f "$CONFIG_PATH" ]]; then
    echo "ERROR: runner config not found at $CONFIG_PATH" >&2
    echo "Run the register command first:" >&2
    echo "  node --experimental-strip-types $RUNNER_DIR/src/cli.ts register --hub <url> --email <email>" >&2
    exit 1
fi

NODE_BIN="$(command -v node || true)"
if [[ -z "$NODE_BIN" ]]; then
    echo "ERROR: node not found in PATH. Install Node.js >= 22 first." >&2
    exit 1
fi

if [[ ! -d "$RUNNER_DIR/node_modules" ]]; then
    echo "ERROR: $RUNNER_DIR/node_modules missing. Run \`npm install\` in the runner dir first." >&2
    exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

# Render template with absolute paths.
sed \
    -e "s|__NODE__|${NODE_BIN}|g" \
    -e "s|__RUNNER_DIR__|${RUNNER_DIR}|g" \
    -e "s|__HOME__|${HOME}|g" \
    "$TEMPLATE" > "$TARGET_PLIST"

# Reload the agent.
launchctl unload "$TARGET_PLIST" 2>/dev/null || true
launchctl load "$TARGET_PLIST"

# launchctl exits 0 even when load actually failed (e.g. plist parse
# error), so verify the agent is registered before claiming success.
if ! launchctl list "$PLIST_LABEL" >/dev/null 2>&1; then
    echo "ERROR: launchctl load reported success but $PLIST_LABEL is not registered" >&2
    echo "  Inspect ${TARGET_PLIST} and try:  launchctl load -w $TARGET_PLIST" >&2
    exit 1
fi

echo "Installed: $TARGET_PLIST"
echo "Logs:      ~/Library/Logs/cc-commander-runner.log"
echo "Stop:      launchctl unload $TARGET_PLIST"
echo "Start:     launchctl load   $TARGET_PLIST"
