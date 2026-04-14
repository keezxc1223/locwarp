#!/usr/bin/env python3
"""
LocWarp 狀態列 App
雙擊 LocWarp.app 啟動，不需要終端機視窗
"""

import os
import sys
import socket
import subprocess
import threading
import time
import webbrowser

import rumps

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(ROOT, "backend")
FRONTEND = os.path.join(ROOT, "frontend")

_venv_python = os.path.join(ROOT, ".venv", "bin", "python3")
PYTHON = _venv_python if os.path.isfile(_venv_python) else sys.executable

BACKEND_PORT = 8777
FRONTEND_PORT = 5173


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


def _kill_port(port: int):
    result = subprocess.run(["lsof", "-ti", f":{port}"],
                            capture_output=True, text=True)
    for pid in result.stdout.strip().splitlines():
        subprocess.run(["kill", "-9", pid], capture_output=True)


class LocWarpApp(rumps.App):
    def __init__(self):
        super().__init__("LocWarp", title="⚫", quit_button=None)

        self._procs: list[subprocess.Popen] = []
        self._running = False
        self._start_thread: threading.Thread | None = None

        self._item_start   = rumps.MenuItem("▶  啟動 LocWarp",  callback=self.on_start)
        self._item_stop    = rumps.MenuItem("■  停止 LocWarp",   callback=self.on_stop)
        self._item_browser = rumps.MenuItem("🌐  開啟瀏覽器",    callback=self.on_browser)
        self._item_urls    = rumps.MenuItem("—")   # 顯示網址，不可點
        self._item_quit    = rumps.MenuItem("結束",              callback=self.on_quit)

        self._item_stop.set_callback(None)     # 初始停用
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

    # ── 啟動 ──────────────────────────────────────────────────

    def on_start(self, _):
        if self._running:
            return
        self._item_start.set_callback(None)
        self.title = "🟡"
        self._start_thread = threading.Thread(target=self._do_start, daemon=True)
        self._start_thread.start()

    def _do_start(self):
        # 清理殘留 port
        for port in (BACKEND_PORT, FRONTEND_PORT):
            if _is_port_open(port):
                _kill_port(port)
                time.sleep(0.5)

        # 啟動後端（需要 sudo）
        backend_cmd = ["sudo", "-n", PYTHON, "main.py"]  # -n = non-interactive
        try:
            bp = subprocess.Popen(backend_cmd, cwd=BACKEND,
                                  stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        except Exception:
            # sudo -n 失敗（需要密碼），改用 osascript 取得授權
            script = (
                f'do shell script "cd {BACKEND} && {PYTHON} main.py" '
                f'with administrator privileges'
            )
            bp = subprocess.Popen(["osascript", "-e", script],
                                  stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        self._procs.append(bp)

        # 等待後端
        if not self._wait_port(BACKEND_PORT, timeout=30):
            self._notify("LocWarp", "後端啟動失敗，請查看 log")
            self._reset_ui()
            return

        # 啟動前端
        fp = subprocess.Popen(
            ["npx", "vite", "--host", "--port", str(FRONTEND_PORT), "--strictPort"],
            cwd=FRONTEND,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        self._procs.append(fp)

        if not self._wait_port(FRONTEND_PORT, timeout=30):
            self._notify("LocWarp", "前端啟動失敗")
            self._reset_ui()
            return

        time.sleep(1.5)  # 等 Vite 首次編譯
        self._running = True

        lan = _get_lan_ip()
        ts  = _get_tailscale_ip()

        url = f"http://localhost:{FRONTEND_PORT}"
        webbrowser.open(url)

        # 更新 UI（rumps 要在主 thread）
        rumps.timers  # 確保 timer 可用
        self._set_running_ui(lan, ts)
        self._notify("LocWarp 已就緒", f"區域網路: {lan}:{FRONTEND_PORT}")

    def _wait_port(self, port: int, timeout: int = 30) -> bool:
        start = time.time()
        while time.time() - start < timeout:
            if _is_port_open(port):
                return True
            time.sleep(1)
        return False

    def _set_running_ui(self, lan: str, ts: str | None):
        self.title = "🟢"
        self._item_stop.set_callback(self.on_stop)
        self._item_browser.set_callback(self.on_browser)

        lines = [f"區域: http://{lan}:{FRONTEND_PORT}"]
        if ts:
            lines.append(f"Tailscale: http://{ts}:{FRONTEND_PORT}")
        self._item_urls.title = "  " + "  |  ".join(lines)

    def _reset_ui(self):
        self.title = "⚫"
        self._item_start.set_callback(self.on_start)
        self._item_stop.set_callback(None)
        self._item_browser.set_callback(None)
        self._item_urls.title = "—"
        self._running = False

    # ── 停止 ──────────────────────────────────────────────────

    def on_stop(self, _):
        self._do_stop()
        self._reset_ui()
        self._notify("LocWarp", "服務已停止")

    def _do_stop(self):
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
        _kill_port(BACKEND_PORT)
        _kill_port(FRONTEND_PORT)
        self._running = False

    # ── 其他 ──────────────────────────────────────────────────

    def on_browser(self, _):
        webbrowser.open(f"http://localhost:{FRONTEND_PORT}")

    def on_quit(self, _):
        if self._running:
            self._do_stop()
        rumps.quit_application()

    @staticmethod
    def _notify(title: str, message: str):
        rumps.notification(title=title, subtitle="", message=message)


if __name__ == "__main__":
    LocWarpApp().run()
