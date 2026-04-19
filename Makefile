# LocWarp — unified build interface
# Usage:
#   make mac          build macOS DMG (native arch)
#   make mac-universal build macOS Universal 2 DMG (arm64 + x64)
#   make win          build Windows NSIS installer (requires Windows / Wine)
#   make frontend     Vite build only
#   make dev          start dev server (frontend + backend side-by-side)
#   make clean        remove all build artefacts

.PHONY: mac mac-universal win frontend dev clean help

# ─── macOS ────────────────────────────────────────────────
mac:
	@bash build-mac.sh

mac-universal:
	@UNIVERSAL=1 bash build-mac.sh

# ─── Windows (run on Windows or cross-compile in CI) ──────
win:
	@cmd /c build-installer.bat 2>/dev/null || \
	  echo "Windows build requires running on Windows or via GitHub Actions CI."

# ─── Frontend only ────────────────────────────────────────
frontend:
	cd frontend && npm run build

# ─── Development ──────────────────────────────────────────
dev:
	@echo "Starting LocWarp dev server..."
	@echo "  Frontend: http://localhost:5173"
	@echo "  Backend:  http://localhost:8777"
	@echo ""
	@python3 start.py

# ─── Clean ────────────────────────────────────────────────
clean:
	rm -rf dist-py/ build-py/
	rm -rf frontend/dist/ frontend/release/
	rm -rf backend/__pycache__ backend/**/__pycache__
	@echo "✅ Cleaned"

# ─── Help ─────────────────────────────────────────────────
help:
	@echo ""
	@echo "  make mac              Build macOS DMG (native arch)"
	@echo "  make mac-universal    Build macOS Universal 2 DMG"
	@echo "  make win              Build Windows NSIS installer"
	@echo "  make frontend         Vite build only"
	@echo "  make dev              Start dev server"
	@echo "  make clean            Remove build artefacts"
	@echo ""
