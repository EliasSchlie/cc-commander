#!/usr/bin/env sh
# Self-update script invoked by the runner when it detects a version
# mismatch with the hub. Runs detached from the runner process; by the
# time this executes, the runner is exiting. launchd (KeepAlive=true)
# restarts the runner against the new code.
#
# Failure handling: on any error, write a marker file the runner reads
# at startup. The runner skips self-update for UPDATE_COOLDOWN_MS while
# the marker is fresh, preventing a 30-second restart loop on persistent
# update failures.
#
# Argument: $1 = target version (informational only — git fetch +
# checkout of origin's default branch is what actually moves the tree).

set -eu

RUNNER_DIR="$(cd "$(dirname "$0")/.." && pwd)"
# Workspaces live at the monorepo root, one level above runner/.
REPO_DIR="$(cd "$RUNNER_DIR/.." && pwd)"
TARGET="${1:-unknown}"
LOG="${HOME}/Library/Logs/cc-commander-runner-update.log"
FAILURE_MARKER="${REPO_DIR}/.cc-commander-update-failure"

mkdir -p "$(dirname "$LOG")"

mark_failure() {
    date '+%Y-%m-%dT%H:%M:%S' > "$FAILURE_MARKER"
    echo "ERROR: $1 — wrote failure marker $FAILURE_MARKER" >> "$LOG"
    exit 1
}

# Give the parent runner a moment to fully exit and release any open
# files / native module bindings (better-sqlite3 etc.) before we git
# checkout + npm ci could rewrite them.
sleep 1

{
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') update → $TARGET ==="
    cd "$REPO_DIR"
    echo "before: $(git rev-parse HEAD 2>/dev/null || echo none)"
} >> "$LOG" 2>&1

if ! git -C "$REPO_DIR" fetch --quiet origin >> "$LOG" 2>&1; then
    mark_failure "git fetch failed"
fi

# Check out whatever origin/HEAD points at (the default branch).
DEFAULT_REF="$(git -C "$REPO_DIR" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
if ! git -C "$REPO_DIR" checkout --quiet -B "${DEFAULT_REF#origin/}" "$DEFAULT_REF" >> "$LOG" 2>&1; then
    mark_failure "git checkout $DEFAULT_REF failed"
fi

{
    echo "after: $(git -C "$REPO_DIR" rev-parse HEAD)"
} >> "$LOG" 2>&1

cd "$REPO_DIR"
# Install at the workspace root so the runner picks up shared workspace
# packages (e.g. @cc-commander/protocol) via the npm-managed symlinks.
if [ -f package-lock.json ]; then
    if ! npm ci --omit=dev --workspace=cc-commander-runner --include-workspace-root >> "$LOG" 2>&1; then
        mark_failure "npm ci failed"
    fi
else
    if ! npm install --omit=dev --workspace=cc-commander-runner --include-workspace-root >> "$LOG" 2>&1; then
        mark_failure "npm install failed"
    fi
fi

# Success: clear any stale failure marker so future updates aren't
# blocked by an old cooldown.
rm -f "$FAILURE_MARKER"
echo "=== update complete ===" >> "$LOG"

# Race window: when the parent runner exited (back at the top of this
# script), launchd restarted it almost immediately -- well before our
# `sleep 1 && git checkout` could land the new tree. The new launchd
# child therefore booted against the OLD tree and is now reporting
# the OLD git SHA via /api/version. Force a SECOND restart so launchd
# boots a fresh runner against the now-updated tree. macOS-only:
# Linux runners would need an analogous systemd `restart` here.
LAUNCHD_LABEL="com.cc-commander.runner"
if command -v launchctl >/dev/null 2>&1; then
    UID_NUM="$(id -u)"
    if launchctl print "gui/${UID_NUM}/${LAUNCHD_LABEL}" >/dev/null 2>&1; then
        echo "kickstarting ${LAUNCHD_LABEL} for second restart" >> "$LOG"
        launchctl kickstart -k "gui/${UID_NUM}/${LAUNCHD_LABEL}" >> "$LOG" 2>&1 || \
            echo "WARN: launchctl kickstart failed" >> "$LOG"
    fi
fi

# launchd will restart the runner because the parent process exited
# cleanly with KeepAlive=true. No explicit relaunch needed.
