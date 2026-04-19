#!/usr/bin/env python3
"""
LocWarp 狀態列 App
雙擊 LocWarp.app 啟動，不需要終端機視窗。

架構說明：
  - 後端以 sudo/osascript 提權啟動，PID 寫入 ~/.locwarp/backend.pid
    以便 on_stop 能精確終止進程（解決 osascript 背景進程追蹤問題）
  - Log 超過 10 MB 自動輪替
  - 啟動失敗時通知顯示最後 3 行 log，方便排錯
"""

from __future__ import annotations

import os
import sys
import socket
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

import rumps

# ── 共用設定 ──────────────────────────────────────────────────────────
from launcher_config import (
    BACKEND_PORT, FRONTEND_PORT,
    backend_dir, frontend_dir, log_dir,
    resolve_python, rotate_log_if_needed, tail_log,
)

ROOT   = Path(__file__).resolve().parent
PYTHON = resolve_python("3.12")

# PID file — allows precise termination even when started via osascript
_PID_FILE = Path.home() / ".locwarp" / "backend.pid"

# Production mode: frontend/dist exists → backend serves the SPA directly,
# no Vite dev server required.
_DIST_PATH = ROOT / "frontend" / "dist"
_PRODUCTION_MODE = (_DIST_PATH / "index.html").is_file()


# ──────────────────────────────────────────────────────────────────────
#  Network helpers
# ──────────────────────────────────────────────────────────────────────

def _get_lan_ip() -> str:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            return s.getsockname()[0]
    except Exception:
        return "127.0.0.1"


def _get_tailscale_ip() -> str | None:
    for ts_bin in [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
    ]:
        if os.path.isfile(ts_bin):
            try:
                r = subprocess.run([ts_bin, "ip", "-4"], capture_output=True,
                                   text=True, timeout=3)
                ip = r.stdout.strip().splitlines()[0].strip()
                if ip.startswith("100."):
                    return ip
            except Exception:
                pass
            break
    return None


def _is_port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except (ConnectionRefusedError, OSError, TimeoutError):
        return False


def _kill_port(port: int) -> None:
    result = subprocess.run(["lsof", "-ti", f":{port}"],
                            capture_output=True, text=True)
    for pid in result.stdout.strip().splitlines():
        try:
            subprocess.run(["kill", "-9", pid], capture_output=True)
        except Exception:
            pass


# ──────────────────────────────────────────────────────────────────────
#  PID-file based process management
# ──────────────────────────────────────────────────────────────────────

def _write_pid(pid: int) -> None:
    try:
        _PID_FILE.parent.mkdir(parents=True, exist_ok=True)
        _PID_FILE.write_text(str(pid))
    except OSError:
        pass


def _read_pid() -> int | None:
    try:
        return int(_PID_FILE.read_text().strip())
    except Exception:
        return None


def _kill_by_pid_file() -> None:
    """Kill process recorded in PID file (bridges osascript-spawned processes)."""
    pid = _read_pid()
    if pid is None:
        return
    try:
        os.kill(pid, 9)
    except ProcessLookupError:
        pass
    except Exception:
        pass
    try:
        _PID_FILE.unlink(missing_ok=True)
    except OSError:
        pass


# ──────────────────────────────────────────────────────────────────────
#  Single-terminal launcher  (tunneld + backend, one sudo password)
# ──────────────────────────────────────────────────────────────────────

def _open_services_terminal(python_path: str, back_dir: Path,
                             backend_log: Path, pid_file: Path) -> None:
    """Open ONE Terminal window that:
      1. Prompts for sudo password once (sudo -v)
      2. Starts tunneld in the background
      3. Waits 2 s, then starts the backend (writes its PID to pid_file)
    All output from both processes goes to backend_log.
    """
    # Use %q-style quoting via a temp shell script to avoid any
    # AppleScript / bash escaping issues with paths that contain
    # spaces, Chinese characters, etc.
    import tempfile, stat

    script_content = f"""#!/bin/bash
echo ''
echo '  ╔══════════════════════════════════════════╗'
echo '  ║   LocWarp — 服務啟動中                   ║'
echo '  ║   請輸入密碼以授予管理員權限              ║'
echo '  ╚══════════════════════════════════════════╝'
echo ''

# 一次取得 sudo 憑證（之後 15 分鐘內不再詢問）
sudo -v || {{ echo '[錯誤] 密碼輸入失敗'; read -p '按 Enter 關閉...'; exit 1; }}

echo ''
echo '  [1/2] 啟動 tunneld (iOS 17+)...'
sudo '{python_path}' -m pymobiledevice3 remote tunneld >> '{backend_log}' 2>&1 &
TUNNELD_PID=$!
sleep 2

echo '  [2/2] 啟動後端服務...'
echo $$ > '{pid_file}'
cd '{back_dir}'
exec sudo '{python_path}' main.py >> '{backend_log}' 2>&1
"""

    # Write to a temp file so no quoting headaches in AppleScript
    tmp = tempfile.NamedTemporaryFile(
        mode="w", suffix=".sh", delete=False, prefix="locwarp_"
    )
    tmp.write(script_content)
    tmp.flush()
    tmp.close()
    os.chmod(tmp.name, stat.S_IRWXU)

    osa = (
        'tell application "Terminal"\n'
        f'    do script "bash {tmp.name}"\n'
        '    activate\n'
        'end tell'
    )
    try:
        subprocess.Popen(["osascript", "-e", osa])
    except Exception:
        pass


# ──────────────────────────────────────────────────────────────────────
#  Environment pre-flight
# ──────────────────────────────────────────────────────────────────────

def _check_pymobiledevice3() -> bool:
    """Return True if pymobiledevice3 is importable from PYTHON."""
    result = subprocess.run(
        [PYTHON, "-c", "import pymobiledevice3"],
        capture_output=True,
    )
    return result.returncode == 0


# ──────────────────────────────────────────────────────────────────────
#  LocWarpApp
# ──────────────────────────────────────────────────────────────────────

class LocWarpApp(rumps.App):
    def __init__(self):
        super().__init__("LocWarp", title="⚫", quit_button=None)

        self._procs: list[subprocess.Popen] = []
        self._running = False
        self._start_thread: threading.Thread | None = None
        self._ui_port: int = BACKEND_PORT if _PRODUCTION_MODE else FRONTEND_PORT

        self._item_start   = rumps.MenuItem("▶  啟動 LocWarp",  callback=self.on_start)
        self._item_stop    = rumps.MenuItem("■  停止 LocWarp",   callback=self.on_stop)
        self._item_browser = rumps.MenuItem("🌐  開啟瀏覽器",    callback=self.on_browser)
        self._item_urls    = rumps.MenuItem("—")
        self._item_quit    = rumps.MenuItem("結束",              callback=self.on_quit)

        self._item_stop.set_callback(None)
        self._item_browser.set_callback(None)

        self.menu = [
            self._item_start,
            self._item_stop,
            None,
            self._item_browser,
            self._item_urls,
            None,
            self._item_quit,
        ]

    # ── Start ──────────────────────────────────────────────────────

    def on_start(self, _):
        if self._running:
            return
        self._item_start.set_callback(None)
        self.title = "🟡"
        self._start_thread = threading.Thread(target=self._do_start, daemon=True)
        self._start_thread.start()

    def _do_start(self):
        try:
            self._do_start_inner()
        except Exception as exc:
            import traceback
            err = traceback.format_exc()
            # Write to log file for diagnosis
            try:
                _log = log_dir() / "menubar-error.log"
                _log.write_text(err)
                print(f"[LocWarp] _do_start crashed → {_log}\n{err}", flush=True)
            except Exception:
                print(f"[LocWarp] _do_start crashed: {exc}", flush=True)
            self._notify("LocWarp 啟動失敗", str(exc)[:200])
            self._reset_ui()

    def _do_start_inner(self):
        # ── Pre-flight: check pymobiledevice3 ─────────────────────
        if not _check_pymobiledevice3():
            self._notify(
                "LocWarp — 缺少依賴",
                f"pymobiledevice3 未安裝\n請執行：\n{PYTHON} -m pip install pymobiledevice3",
            )
            self._reset_ui()
            return

        # ── 清理殘留 port 與舊 PID ─────────────────────────────────
        _kill_by_pid_file()
        for port in (BACKEND_PORT, FRONTEND_PORT):
            if _is_port_open(port):
                _kill_port(port)
                time.sleep(0.5)

        # ── 準備後端 log ───────────────────────────────────────────
        backend_log = log_dir() / "backend-menubar.log"
        rotate_log_if_needed(backend_log)

        # ── 用單一 Terminal 視窗啟動 tunneld + 後端（一次密碼）────
        _open_services_terminal(PYTHON, backend_dir(), backend_log, _PID_FILE)

        # ── 等待後端 HTTP ──────────────────────────────────────────
        if not self._wait_port(BACKEND_PORT, timeout=40):
            last_lines = tail_log(backend_log)
            self._notify(
                "LocWarp — 後端啟動失敗",
                f"Log 末尾：\n{last_lines}",
            )
            self._reset_ui()
            return

        # ── 前端 ──────────────────────────────────────────────────
        # 生產模式：backend 直接托管 frontend/dist，無需 Vite 或 Node.js
        # 開發模式：啟動 Vite dev server
        if _PRODUCTION_MODE:
            ui_port = BACKEND_PORT
            time.sleep(0.5)   # 讓 uvicorn 完成靜態掛載初始化
        else:
            frontend_log = log_dir() / "frontend-menubar.log"
            rotate_log_if_needed(frontend_log)

            try:
                fp = subprocess.Popen(
                    ["npx", "vite", "--host",
                     "--port", str(FRONTEND_PORT), "--strictPort"],
                    cwd=str(frontend_dir()),
                    stdout=open(frontend_log, "a"),
                    stderr=subprocess.STDOUT,
                )
                self._procs.append(fp)
            except FileNotFoundError:
                self._notify("LocWarp — 前端啟動失敗",
                             "找不到 npx，請確認已安裝 Node.js")
                self._reset_ui()
                return

            if not self._wait_port(FRONTEND_PORT, timeout=30):
                last_lines = tail_log(frontend_log)
                self._notify(
                    "LocWarp — 前端啟動失敗",
                    f"Log 末尾：\n{last_lines}",
                )
                self._reset_ui()
                return

            time.sleep(1.2)   # 等 Vite 首次編譯
            ui_port = FRONTEND_PORT

        self._running = True

        lan = _get_lan_ip()
        ts  = _get_tailscale_ip()

        webbrowser.open(f"http://localhost:{ui_port}")
        self._set_running_ui(lan, ts, ui_port)
        mode_hint = "（生產模式，無需 Node.js）" if _PRODUCTION_MODE else "（開發模式）"
        self._notify(
            "LocWarp 已就緒 ✅",
            f"瀏覽器已開啟 {mode_hint}\n區域: {lan}:{ui_port}",
        )

    def _wait_port(self, port: int, timeout: int = 30) -> bool:
        start = time.time()
        while time.time() - start < timeout:
            if _is_port_open(port):
                return True
            time.sleep(1)
        return False

    # ── Running UI ─────────────────────────────────────────────────

    def _set_running_ui(self, lan: str, ts: str | None, ui_port: int):
        self._ui_port = ui_port   # remember for on_browser
        self.title = "🟢"
        self._item_stop.set_callback(self.on_stop)
        self._item_browser.set_callback(self.on_browser)
        lines = [f"區域: http://{lan}:{ui_port}"]
        if ts:
            lines.append(f"Tailscale: http://{ts}:{ui_port}")
        self._item_urls.title = "  " + "  |  ".join(lines)

    def _reset_ui(self):
        self.title = "⚫"
        self._item_start.set_callback(self.on_start)
        self._item_stop.set_callback(None)
        self._item_browser.set_callback(None)
        self._item_urls.title = "—"
        self._running = False

    # ── Stop ───────────────────────────────────────────────────────

    def on_stop(self, _):
        self._do_stop()
        self._reset_ui()
        self._notify("LocWarp", "服務已停止")

    def _do_stop(self):
        # 1. SIGTERM all tracked Popen handles
        for p in self._procs:
            try:
                p.terminate()
                p.wait(timeout=3)
            except Exception:
                try:
                    p.kill()
                except Exception:
                    pass
        self._procs.clear()

        # 2. Kill via PID file (catches osascript-spawned backend)
        _kill_by_pid_file()

        # 3. Force-kill any remaining process holding the ports
        _kill_port(BACKEND_PORT)
        if not _PRODUCTION_MODE:
            _kill_port(FRONTEND_PORT)
        self._running = False

    # ── Misc ───────────────────────────────────────────────────────

    def on_browser(self, _):
        webbrowser.open(f"http://localhost:{self._ui_port}")

    def on_quit(self, _):
        if self._running:
            self._do_stop()
        rumps.quit_application()

    @staticmethod
    def _notify(title: str, message: str):
        rumps.notification(title=title, subtitle="", message=message)


if __name__ == "__main__":
    LocWarpApp().run()
