#!/usr/bin/env sh
# Self-update script invoked by the runner when it detects a version
# mismatch with the hub. Runs detached from the runner process — by the
# time this executes, the runner has either already exited or is about
# to. launchd (KeepAlive=true) restarts the runner against the new code.
#
# Argument: $1 = target version (informational only — git fetch + checkout
# of origin's default branch is what actually moves the working tree).
#
# This deliberately does NOT check out a specific SHA. The hub's VERSION
# is the target, but the *source of truth* for "what the runner should
# run" is the runner repository's tracked branch on origin. CI bumps both
# in lockstep: tag/release → hub image rebuilt → main updated → runners
# pull main on next poll.

set -eu

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${1:-unknown}"
LOG="${HOME}/Library/Logs/cc-commander-runner-update.log"

mkdir -p "$(dirname "$LOG")"

{
    echo "=== $(date '+%Y-%m-%d %H:%M:%S') update → $TARGET ==="
    cd "$REPO_DIR"
    echo "before: $(git rev-parse HEAD 2>/dev/null || echo none)"

    if ! git fetch --quiet origin; then
        echo "ERROR: git fetch failed"
        exit 1
    fi

    # Check out whatever origin/HEAD points at (the default branch).
    DEFAULT_REF="$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo origin/main)"
    if ! git checkout --quiet -B "${DEFAULT_REF#origin/}" "$DEFAULT_REF"; then
        echo "ERROR: git checkout $DEFAULT_REF failed"
        exit 1
    fi
    echo "after: $(git rev-parse HEAD)"

    if [ -f package-lock.json ]; then
        if ! npm ci --silent --omit=dev; then
            echo "ERROR: npm ci failed"
            exit 1
        fi
    else
        if ! npm install --silent --omit=dev; then
            echo "ERROR: npm install failed"
            exit 1
        fi
    fi

    echo "=== update complete ==="
} >> "$LOG" 2>&1

# launchd will restart the runner because the parent process exited
# cleanly with KeepAlive=true. No explicit relaunch needed.
