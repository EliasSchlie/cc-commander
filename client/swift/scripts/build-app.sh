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

set -euo pipefail

# Resolve the swift project dir relative to this script so callers can
# run it from anywhere.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SWIFT_DIR="$(dirname "$SCRIPT_DIR")"
EXPECTED_TEAM="Q2U8K9N3BL"

cd "$SWIFT_DIR"

# Build with no signing override flags. xcodebuild picks up the
# DEVELOPMENT_TEAM and CODE_SIGN_STYLE = Automatic baked into project.yml
# (and from there into the regenerated .xcodeproj).
echo "→ Building CCCommander_macOS (signed with team $EXPECTED_TEAM)…" >&2
xcodebuild build \
  -project CCCommander.xcodeproj \
  -scheme CCCommander_macOS \
  -destination 'platform=macOS' \
  -quiet >&2

# Find the most recently-built .app under DerivedData. The hash in the
# DerivedData directory name depends on the absolute project path, so
# different worktrees produce different paths -- always pick the newest.
# Use -print0 / -exec to be safe with paths containing spaces or newlines.
APP=$(find ~/Library/Developer/Xcode/DerivedData \
        -maxdepth 6 \
        -path '*CCCommander*/Build/Products/Debug/CCCommander.app' \
        -exec stat -f '%m %N' {} + 2>/dev/null \
      | sort -rn \
      | head -1 \
      | cut -d' ' -f2-)

if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "✗ build succeeded but no CCCommander.app was found under DerivedData" >&2
  exit 1
fi

# Verify the signature is the stable team. If it's `not set`, the
# binary is ad-hoc and will trigger a keychain prompt on launch --
# bail loudly so the user notices instead of stumbling into the
# prompt at runtime.
ACTUAL_TEAM=$(codesign -dvv "$APP" 2>&1 | awk -F= '/^TeamIdentifier=/ {print $2}')
if [[ "$ACTUAL_TEAM" != "$EXPECTED_TEAM" ]]; then
  echo "✗ binary at $APP is signed with team '$ACTUAL_TEAM', expected '$EXPECTED_TEAM'" >&2
  echo "  This will trigger a macOS Keychain prompt on launch." >&2
  echo "  Check that project.yml has DEVELOPMENT_TEAM = $EXPECTED_TEAM" >&2
  echo "  and that nothing in your shell environment overrides it." >&2
  exit 2
fi

echo "✓ Signed with $ACTUAL_TEAM" >&2
echo "$APP"
