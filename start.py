"""
LocWarp 一鍵啟動器 — 終端機版
雙擊或在終端機執行即可啟動後端 + 前端開發伺服器。
"""

from __future__ import annotations

import subprocess
import sys
import os
import time
import socket
import webbrowser
from pathlib import Path

# ── 共用設定 ────────────────────────────────────────────────────────────
from launcher_config import (
    BACKEND_PORT, FRONTEND_PORT,
    backend_dir, frontend_dir, log_dir,
    resolve_python, rotate_log_if_needed,
)

ROOT   = Path(__file__).resolve().parent
PYTHON = resolve_python("3.12")

# Production mode: frontend/dist exists → backend serves the SPA directly
_DIST_PATH = ROOT / "frontend" / "dist"
PRODUCTION_MODE = (_DIST_PATH / "index.html").is_file()

procs: list[subprocess.Popen] = []


# ──────────────────────────────────────────────────────────────────────
#  Banner & utilities
# ──────────────────────────────────────────────────────────────────────

def print_banner():
    mode = "生產模式 (無需 Node.js)" if PRODUCTION_MODE else "開發模式 (需要 Node.js)"
    print()
    print("  ╔══════════════════════════════════════════╗")
    print("  ║   LocWarp — iOS 虛擬定位模擬器           ║")
    print(f"  ║   {mode:<38}║")
    print("  ╚══════════════════════════════════════════╝")
    print()


def check_tool(name: str, hint: str) -> bool:
    import shutil
    if shutil.which(name):
        print(f"  [✓] 已找到 {name}")
        return True
    print(f"  [✗] 找不到 {name}，請先安裝：{hint}")
    return False


def is_port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except (ConnectionRefusedError, OSError, TimeoutError):
        return False


def kill_port(port: int) -> None:
    if os.name == "nt":
        result = subprocess.run(
            f'netstat -ano | findstr ":{port}" | findstr "LISTENING"',
            capture_output=True, text=True, shell=True,
        )
        for line in result.stdout.strip().splitlines():
            parts = line.split()
            if parts:
                subprocess.run(f"taskkill /pid {parts[-1]} /f",
                               shell=True, capture_output=True)
    else:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True,
        )
        for pid in result.stdout.strip().splitlines():
            subprocess.run(["kill", "-9", pid], capture_output=True)


def wait_for_port(port: int, label: str, timeout: int = 60) -> bool:
    print(f"      等待{label}啟動中", end="", flush=True)
    start = time.time()
    while time.time() - start < timeout:
        if is_port_open(port):
            print(" OK ✓")
            return True
        print(".", end="", flush=True)
        time.sleep(2)
    print(" 超時！")
    return False


# ──────────────────────────────────────────────────────────────────────
#  Pre-flight checks
# ──────────────────────────────────────────────────────────────────────

def check_python_deps() -> bool:
    """Verify critical Python packages are installed."""
    missing = []
    for pkg in ("pymobiledevice3", "fastapi", "uvicorn"):
        result = subprocess.run(
            [PYTHON, "-c", f"import {pkg}"],
            capture_output=True,
        )
        if result.returncode != 0:
            missing.append(pkg)

    if missing:
        print(f"  [✗] 缺少 Python 套件：{', '.join(missing)}")
        req = backend_dir() / "requirements.txt"
        print(f"      請執行：{PYTHON} -m pip install -r {req}")
        return False

    print("  [✓] Python 依賴套件已就緒")
    return True


# ──────────────────────────────────────────────────────────────────────
#  Install / build steps
# ──────────────────────────────────────────────────────────────────────

def install_backend() -> None:
    print("  [1/4] 檢查後端依賴...", end=" ", flush=True)
    req = backend_dir() / "requirements.txt"

    dry = subprocess.run(
        [PYTHON, "-m", "pip", "install", "-r", str(req), "--dry-run"],
        capture_output=True, text=True,
    )
    if "would install" not in dry.stdout.lower():
        print("已就緒 ✓")
    else:
        print("安裝中...")
        subprocess.run(
            [PYTHON, "-m", "pip", "install", "-r", str(req), "-q"],
            cwd=str(backend_dir()),
        )
        print("        完成 ✓")


def install_frontend() -> None:
    """Install npm packages if needed, then build dist/ if missing or stale."""
    # ── npm install ──────────────────────────────────────────
    print("  [2/4] 檢查前端依賴...", end=" ", flush=True)
    nm   = frontend_dir() / "node_modules"
    lock = nm / ".package-lock.json"
    pkg  = frontend_dir() / "package.json"

    needs_install = (
        not nm.is_dir()
        or not lock.exists()
        or (pkg.stat().st_mtime > lock.stat().st_mtime)
    )

    if needs_install:
        print("安裝中...")
        subprocess.run(
            ["npm", "install"],
            cwd=str(frontend_dir()),
            shell=(os.name == "nt"),
        )
        print("        完成 ✓")
    else:
        print("已就緒 ✓")

    # ── npm run build ─────────────────────────────────────────
    dist      = frontend_dir() / "dist"
    index     = dist / "index.html"
    # Rebuild if dist missing, or any src file is newer than index.html
    src_files = list((frontend_dir() / "src").rglob("*"))
    needs_build = (
        not index.is_file()
        or (src_files and max(f.stat().st_mtime for f in src_files if f.is_file())
            > index.stat().st_mtime)
    )

    if needs_build:
        print("  [2/4] 建置前端...", end=" ", flush=True)
        result = subprocess.run(
            ["npm", "run", "build"],
            cwd=str(frontend_dir()),
            shell=(os.name == "nt"),
        )
        if result.returncode == 0:
            print("完成 ✓")
        else:
            print("失敗！將改用 Vite dev server")
            # dist 建置失敗，退回開發模式（PRODUCTION_MODE 不變，稍後 start_frontend 接手）
    else:
        print("  [2/4] 前端已是最新版本 ✓")


# ──────────────────────────────────────────────────────────────────────
#  Service start
# ──────────────────────────────────────────────────────────────────────

def start_tunneld() -> None:
    """Open a separate Terminal window running tunneld (iOS 17+, macOS only)."""
    if os.name == "nt":
        return  # Windows 不需要

    cmd = (
        "echo '';"
        "echo '  ╔══════════════════════════════════════════╗';"
        "echo '  ║  LocWarp — Tunneld  (iOS 17+)            ║';"
        "echo '  ║  保持此視窗開啟，關閉將中斷 GPS 服務     ║';"
        "echo '  ╚══════════════════════════════════════════╝';"
        "echo '';"
        f"sudo '{PYTHON}' -m pymobiledevice3 remote tunneld"
    )
    script = (
        'tell application "Terminal"\n'
        f'    do script "{cmd}"\n'
        '    activate\n'
        'end tell'
    )
    try:
        subprocess.Popen(["osascript", "-e", script])
        print("  [✓] tunneld 視窗已開啟（請在該視窗輸入密碼）")
    except Exception as e:
        print(f"  [!] 無法開啟 tunneld 視窗：{e}")


def start_backend() -> bool:
    port = BACKEND_PORT
    print(f"  [3/4] 啟動後端服務 (port {port})...")

    if is_port_open(port):
        print(f"      Port {port} 被佔用，清理中...")
        kill_port(port)
        time.sleep(1)

    # Rotate log if large
    backend_log = log_dir() / "backend.log"
    rotate_log_if_needed(backend_log)

    if os.name == "nt":
        cmd: list[str] = [PYTHON, "main.py"]
        kwargs: dict = {"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP}
    else:
        cmd = ["sudo", PYTHON, "main.py"]
        kwargs = {}

    p = subprocess.Popen(cmd, cwd=str(backend_dir()), **kwargs)
    procs.append(p)
    return wait_for_port(port, "後端")


def start_frontend() -> bool:
    """Start Vite dev server (dev mode only). Skipped in production mode."""
    port = FRONTEND_PORT
    print(f"  [4/4] 啟動前端服務 (port {port})...")

    if is_port_open(port):
        print(f"      Port {port} 被佔用，清理中...")
        kill_port(port)
        time.sleep(1)

    kwargs_common: dict = {
        "cwd": str(frontend_dir()),
        "shell": (os.name == "nt"),
    }
    if os.name == "nt":
        kwargs_common["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP

    p = subprocess.Popen(
        ["npx", "vite", "--host", "--port", str(port), "--strictPort"],
        **kwargs_common,
    )
    procs.append(p)
    return wait_for_port(port, "前端")


# ──────────────────────────────────────────────────────────────────────
#  Cleanup
# ──────────────────────────────────────────────────────────────────────

def cleanup() -> None:
    print("\n  正在關閉所有服務...")
    for p in procs:
        try:
            p.terminate()
            p.wait(timeout=5)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass
    kill_port(BACKEND_PORT)
    if not PRODUCTION_MODE:
        kill_port(FRONTEND_PORT)
    print("  已停止。再見！")


# ──────────────────────────────────────────────────────────────────────
#  Main
# ──────────────────────────────────────────────────────────────────────

def check_admin_windows() -> bool:
    import ctypes
    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())
    except Exception:
        return False


def main():
    if os.name == "nt":
        os.system("title LocWarp")
    print_banner()

    # ── 管理員警告（Windows）──────────────────────────────────────
    if os.name == "nt" and not check_admin_windows():
        print("  [!] 未以系統管理員身份執行")
        print("      iOS 17+ 裝置需要管理員權限才能建立通道")
        print("      請右鍵 LocWarp.bat → 以系統管理員身份執行")
        print()

    # ── 基本工具檢查 ──────────────────────────────────────────────
    import shutil
    python_cmd = "python" if os.name == "nt" else "python3"
    ok = True
    ok = check_tool(python_cmd, "https://www.python.org/downloads/") and ok
    ok = check_tool("node", "https://nodejs.org/") and ok
    ok = check_tool("npm", "隨 Node.js 一起安裝") and ok
    print()

    if not ok:
        input("  缺少必要工具，請安裝後重試。按 Enter 離開...")
        return

    # ── Python 套件檢查（pymobiledevice3 等）──────────────────────
    if not check_python_deps():
        print()
        input("  請安裝後重試。按 Enter 離開...")
        return
    print()

    # ── 安裝依賴 ─────────────────────────────────────────────────
    install_backend()
    print()
    install_frontend()   # npm install + npm run build（自動判斷是否需要）
    print()

    # 建置後重新偵測（第一次執行時 dist 剛剛才建好）
    prod = (_DIST_PATH / "index.html").is_file()

    # ── 啟動 tunneld（iOS 17+，macOS 專用）──────────────────────
    start_tunneld()
    print()

    # ── 啟動服務 ─────────────────────────────────────────────────
    if not start_backend():
        print("  [錯誤] 後端啟動失敗")
        cleanup()
        input("  按 Enter 離開...")
        return
    print()

    if prod:
        # 後端已托管前端靜態檔案，稍等初始化完成
        time.sleep(0.5)
        ui_port = BACKEND_PORT
    else:
        if not start_frontend():
            print("  [錯誤] 前端啟動失敗")
            cleanup()
            input("  按 Enter 離開...")
            return
        print()
        ui_port = FRONTEND_PORT

    # ── 偵測 IP ──────────────────────────────────────────────────
    lan_ip = "127.0.0.1"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            lan_ip = s.getsockname()[0]
    except Exception:
        pass

    tailscale_ip = None
    for ts_bin in [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
    ]:
        if os.path.isfile(ts_bin):
            try:
                result = subprocess.run([ts_bin, "ip", "-4"],
                                        capture_output=True, text=True, timeout=3)
                ip = result.stdout.strip().splitlines()[0].strip()
                if ip.startswith("100."):
                    tailscale_ip = ip
            except Exception:
                pass
            break

    time.sleep(1)
    webbrowser.open(f"http://localhost:{ui_port}")

    print("  ╔══════════════════════════════════════════╗")
    print("  ║          LocWarp 已就緒！                ║")
    print("  ╠══════════════════════════════════════════╣")
    print(f"  ║  本機:      http://localhost:{ui_port}        ║")
    print(f"  ║  區域網路:  http://{lan_ip}:{ui_port}   ║")
    if tailscale_ip:
        print(f"  ║  Tailscale: http://{tailscale_ip}:{ui_port}  ║")
    else:
        print( "  ║  Tailscale: (未偵測到，請確認已啟動)  ║")
    print("  ╠══════════════════════════════════════════╣")
    print("  ║  按 Enter 停止所有服務                   ║")
    print("  ╚══════════════════════════════════════════╝")
    print()

    try:
        input()
    except (KeyboardInterrupt, EOFError):
        pass

    cleanup()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        cleanup()
