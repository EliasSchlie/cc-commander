#!/usr/bin/env bash
# Build CCCommander.app with the stable Apple Developer team baked into
# project.yml and verify the resulting binary is signed with that team
# (not ad-hoc). Prints the path to the built .app on stdout so callers
# can `open "$(scripts/build-app.sh)"`.
#
# This script is the *only* sanctioned way to build the local app: any
# other invocation that passes DEVELOPMENT_TEAM= or CODE_SIGN_IDENTITY=-
# will produce an unsigned binary, which makes the macOS Keychain ACL on
# your stored JWT mismatch and prompt for "allow / deny" on every launch.
#
# Forks: override the expected team via `CCC_EXPECTED_TEAM=YOURTEAM ./scripts/build-app.sh`
# (and update project.yml to match).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(dirname "$SCRIPT_DIR")"
EXPECTED_TEAM="${CCC_EXPECTED_TEAM:-Q2U8K9N3BL}"

cd "$SWIFT_DIR"

# Ask xcodebuild where it WILL put the build product *before* building.
# This is the authoritative answer -- the alternative is scanning
# DerivedData for the newest CCCommander.app, which races against
# parallel builds and second-resolution mtimes. The DerivedData hash
# depends on the absolute project path, so each worktree gets its own
# directory; -showBuildSettings reveals the right one for THIS worktree
# without us having to guess.
BUILD_DIR=$(xcodebuild -showBuildSettings \
    -project CCCommander.xcodeproj \
    -scheme CCCommander_macOS \
    -destination 'platform=macOS' \
    2>/dev/null \
  | awk -F' = ' '/^[[:space:]]*BUILT_PRODUCTS_DIR / {print $2; exit}')

if [[ -z "$BUILD_DIR" ]]; then
  echo "✗ failed to read BUILT_PRODUCTS_DIR from xcodebuild -showBuildSettings" >&2
  echo "  Run \`xcodebuild -showBuildSettings -project CCCommander.xcodeproj -scheme CCCommander_macOS\` manually to debug." >&2
  exit 1
fi
APP="$BUILD_DIR/CCCommander.app"

# Run the build. `-quiet` suppresses informational output (per-target
# compile commands, dependency graph dumps) but Apple's documentation
# is explicit that errors and warnings still go to stderr -- so a
# compile failure is visible AND `set -e` aborts the script at that
# point. Without -quiet, a clean build dumps ~200 KB of chatter.
echo "→ Building CCCommander_macOS (signing for team $EXPECTED_TEAM)…" >&2
xcodebuild build \
  -project CCCommander.xcodeproj \
  -scheme CCCommander_macOS \
  -destination 'platform=macOS' \
  -quiet >&2

if [[ ! -d "$APP" ]]; then
  echo "✗ build reported success but $APP doesn't exist" >&2
  exit 1
fi

# Verify the signature. If `codesign` itself fails (file not signed at
# all, missing tool), we want a distinct error from "team mismatch" so
# split the exit-code check from the team-name check.
if ! CODESIGN_OUT=$(codesign -dvv "$APP" 2>&1); then
  echo "✗ codesign failed on $APP:" >&2
  printf '    %s\n' "${CODESIGN_OUT//$'\n'/$'\n    '}" >&2
  exit 2
fi
ACTUAL_TEAM=$(printf '%s\n' "$CODESIGN_OUT" | awk -F= '/^TeamIdentifier=/ {print $2}')
if [[ "$ACTUAL_TEAM" != "$EXPECTED_TEAM" ]]; then
  echo "✗ binary at $APP is signed with team '$ACTUAL_TEAM', expected '$EXPECTED_TEAM'" >&2
  echo "  This will trigger a macOS Keychain prompt on launch." >&2
  echo "  Check that project.yml has DEVELOPMENT_TEAM = $EXPECTED_TEAM" >&2
  echo "  and that nothing in your shell environment overrides it." >&2
  echo "  (To override the expected team for a fork, set CCC_EXPECTED_TEAM.)" >&2
  exit 2
fi

echo "✓ Signed with $ACTUAL_TEAM" >&2
echo "$APP"
