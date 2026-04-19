#!/usr/bin/env bash
# Pre-sign all native binaries in PyInstaller output for macOS notarization.
# Must be run with an Apple Developer certificate in the Keychain.
# Usage: ./scripts/sign-dylibs.sh [IDENTITY]
#   IDENTITY defaults to "Developer ID Application" (partial match)
#
# Run this BEFORE electron-builder, e.g.:
#   ./scripts/sign-dylibs.sh && npm run dist:mac

set -euo pipefail

IDENTITY="${1:-Developer ID Application}"
BACKEND_DIR="${DIST_PY:-../dist-py}/locwarp-backend"
TUNNEL_DIR="${DIST_PY:-../dist-py}/wifi-tunnel"
ENTITLEMENTS="$(dirname "$0")/../frontend/build/entitlements.mac.plist"

sign_dir() {
  local dir="$1"
  if [ ! -d "$dir" ]; then
    echo "⚠  Directory not found, skipping: $dir"
    return
  fi
  echo "🔏 Signing binaries in: $dir"
  # Sign all .dylib and .so files first (deepest first)
  find "$dir" \( -name "*.dylib" -o -name "*.so" \) | while read -r f; do
    codesign --force --sign "$IDENTITY" \
             --options runtime \
             --entitlements "$ENTITLEMENTS" \
             "$f" 2>/dev/null && echo "   signed: $(basename "$f")" || true
  done
  # Sign the main executable last
  local exe
  exe=$(find "$dir" -maxdepth 1 -type f -perm +0111 | head -1)
  if [ -n "$exe" ]; then
    codesign --force --sign "$IDENTITY" \
             --options runtime \
             --entitlements "$ENTITLEMENTS" \
             "$exe"
    echo "   signed executable: $(basename "$exe")"
  fi
  echo "✅ Done: $dir"
}

sign_dir "$BACKEND_DIR"
sign_dir "$TUNNEL_DIR"
echo ""
echo "All binaries signed. You can now run: npm run dist:mac"
