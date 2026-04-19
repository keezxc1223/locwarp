#!/usr/bin/env bash
# ============================================================
#  LocWarp — macOS one-shot build
#  Produces: frontend/release/LocWarp-*.dmg
#
#  Prerequisites (install once):
#    brew install python@3.12 python@3.13 node
#    pip3.12 install -r backend/requirements.txt pyinstaller
#    pip3.13 install pymobiledevice3 pytun-pmd3 pyinstaller
#    cd frontend && npm install
#
#  Optional (for notarisation):
#    export APPLE_ID="you@example.com"
#    export APPLE_APP_SPECIFIC_PASSWORD="xxxx-xxxx-xxxx-xxxx"
#    export APPLE_TEAM_ID="XXXXXXXXXX"
# ============================================================

set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# ── Colour helpers ─────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'
step()  { echo -e "\n${CYAN}${BOLD}[$1/5]${NC} $2"; }
ok()    { echo -e "  ${GREEN}✅ $1${NC}"; }
warn()  { echo -e "  ${YELLOW}⚠  $1${NC}"; }
die()   { echo -e "  ${RED}❌ $1${NC}" >&2; exit 1; }

# ── Auto-detect Python ─────────────────────────────────────
find_python() {
  local want="$1"
  # Homebrew default paths first (Apple Silicon + Intel), then pyenv, then $PATH
  local candidates=(
    "/opt/homebrew/opt/python@${want}/bin/python${want}"
    "/usr/local/opt/python@${want}/bin/python${want}"
    "python${want}"
    "python3"
  )
  # pyenv support
  if command -v pyenv &>/dev/null; then
    local p; p=$(pyenv prefix "${want}" 2>/dev/null)/bin/python3
    [[ -x "$p" ]] && candidates=("$p" "${candidates[@]}")
  fi
  for c in "${candidates[@]}"; do
    if command -v "$c" &>/dev/null 2>&1; then
      local ver; ver=$("$c" -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>/dev/null) || continue
      if [[ "$ver" == "${want}"* ]]; then echo "$c"; return 0; fi
    fi
  done
  return 1
}

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${BOLD}║    LocWarp  —  macOS Build  ($(date +%H:%M))          ║${NC}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${NC}"

# ── Resolve Python binaries ────────────────────────────────
PY312=$(find_python 3.12) || die "Python 3.12 not found.\n  Install: brew install python@3.12"
PY313=$(find_python 3.13) || die "Python 3.13 not found.\n  Install: brew install python@3.13"
ok "Python 3.12 → $PY312"
ok "Python 3.13 → $PY313"

# ── Check Node ─────────────────────────────────────────────
command -v node &>/dev/null || die "Node.js not found. Install: brew install node"
command -v npm  &>/dev/null || die "npm not found."
ok "Node $(node -v)"

# ── Output dirs ────────────────────────────────────────────
DIST_PY="$ROOT/dist-py"
BUILD_PY="$ROOT/build-py"
mkdir -p "$DIST_PY" "$BUILD_PY"

# ──────────────────────────────────────────────────────────
step 1 "Build backend  (Python 3.12  →  PyInstaller)"
# ──────────────────────────────────────────────────────────
cd "$ROOT/backend"
"$PY312" -m PyInstaller locwarp-backend.spec \
  --noconfirm \
  --distpath "$DIST_PY" \
  --workpath "$BUILD_PY/backend"
ok "locwarp-backend built → $DIST_PY/locwarp-backend/"
cd "$ROOT"

# ──────────────────────────────────────────────────────────
step 2 "Build WiFi tunnel  (Python 3.13  →  PyInstaller)"
# ──────────────────────────────────────────────────────────
"$PY313" -m PyInstaller wifi-tunnel.spec \
  --noconfirm \
  --distpath "$DIST_PY" \
  --workpath "$BUILD_PY/tunnel"
ok "wifi-tunnel built → $DIST_PY/wifi-tunnel/"

# ──────────────────────────────────────────────────────────
step 3 "Pre-sign native binaries  (codesign)"
# ──────────────────────────────────────────────────────────
if security find-identity -v -p codesigning 2>/dev/null | grep -q "Developer ID Application"; then
  IDENTITY=$(security find-identity -v -p codesigning 2>/dev/null \
    | grep "Developer ID Application" | head -1 \
    | sed -E 's/.*"(Developer ID Application[^"]+)".*/\1/')
  bash "$ROOT/scripts/sign-dylibs.sh" "$IDENTITY"
  ok "Signed with: $IDENTITY"
else
  warn "No 'Developer ID Application' cert found — using ad-hoc signature."
  warn "App will work locally but cannot be distributed without a cert."
  # Ad-hoc sign so Gatekeeper doesn't block local testing
  for dir in "$DIST_PY/locwarp-backend" "$DIST_PY/wifi-tunnel"; do
    [[ -d "$dir" ]] || continue
    find "$dir" \( -name "*.dylib" -o -name "*.so" \) -exec \
      codesign --force --sign - {} \; 2>/dev/null || true
    local_exe=$(find "$dir" -maxdepth 1 -type f -perm +0111 | head -1)
    [[ -n "$local_exe" ]] && codesign --force --sign - "$local_exe" 2>/dev/null || true
  done
  ok "Ad-hoc signed"
fi

# ──────────────────────────────────────────────────────────
step 4 "Build frontend  (Vite)"
# ──────────────────────────────────────────────────────────
cd "$ROOT/frontend"
[[ -d node_modules ]] || npm install
npm run build
ok "Vite build complete → frontend/dist/"

# ──────────────────────────────────────────────────────────
step 5 "Package Electron  →  DMG"
# ──────────────────────────────────────────────────────────
# Detect architecture for optimal target
ARCH=$(uname -m)
if [[ "$ARCH" == "arm64" ]]; then
  TARGET_ARCH="arm64"
  warn "Building arm64 only (native M-series). For universal: npm run dist:mac:universal"
else
  TARGET_ARCH="x64"
fi

npx electron-builder --mac dmg --${TARGET_ARCH}
ok "DMG built → frontend/release/"

# ──────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}${BOLD}║   ✅  Build complete!                        ║${NC}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
ls "$ROOT/frontend/release/"*.dmg 2>/dev/null | while read f; do
  echo -e "  📦  $(basename "$f")  ($(du -sh "$f" | cut -f1))"
done
echo ""
