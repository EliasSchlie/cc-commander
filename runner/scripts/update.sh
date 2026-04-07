#!/usr/bin/env sh
# Self-update script invoked SYNCHRONOUSLY by the runner when it
# detects a version mismatch with the hub. The runner spawns this
# script via spawnSync and waits for it to complete BEFORE exiting,
# so by the time launchd's KeepAlive boots a replacement runner, the
# new tree is already on disk. (Earlier versions ran the script
# detached and raced launchd's restart -- see PR #65 / PR #67.)
#
# Failure handling: on any error, write a marker file the runner
# reads at startup. The runner skips self-update for
# UPDATE_COOLDOWN_MS while the marker is fresh, preventing a
# 30-second restart loop on persistent update failures.
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

# Return cleanly to the parent runner. The parent will then exit
# and launchd's KeepAlive will boot a replacement against the new
# tree -- guaranteed against the new SHA, no race.
