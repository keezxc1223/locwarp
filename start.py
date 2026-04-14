"""
LocWarp 一鍵啟動器
雙擊此檔案即可啟動 LocWarp
"""

import subprocess
import sys
import os
import time
import shutil
import webbrowser
import urllib.request
import socket

# 路徑設定
ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(ROOT, "backend")
FRONTEND = os.path.join(ROOT, "frontend")

# 優先使用專案虛擬環境的 Python
_venv_python = os.path.join(ROOT, ".venv", "bin", "python3")
if os.path.isfile(_venv_python):
    PYTHON = _venv_python
else:
    PYTHON = sys.executable

BACKEND_PORT = 8777
FRONTEND_PORT = 5173

procs = []


def print_banner():
    print()
    print("  ╔══════════════════════════════════════════╗")
    print("  ║   LocWarp — iOS 虛擬定位模擬器 v0.1     ║")
    print("  ╚══════════════════════════════════════════╝")
    print()


def check_tool(name, hint):
    if shutil.which(name):
        print(f"  [✓] 已找到 {name}")
        return True
    else:
        print(f"  [✗] 找不到 {name}，請先安裝：{hint}")
        return False


def is_port_open(port):
    """檢查 port 是否有服務在監聽"""
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=1):
            return True
    except (ConnectionRefusedError, OSError, TimeoutError):
        return False


def kill_port(port):
    """清理佔用指定 port 的進程"""
    if os.name == "nt":
        result = subprocess.run(
            f'netstat -ano | findstr ":{port}" | findstr "LISTENING"',
            capture_output=True, text=True, shell=True,
        )
        for line in result.stdout.strip().splitlines():
            parts = line.split()
            if parts:
                pid = parts[-1]
                subprocess.run(f"taskkill /pid {pid} /f",
                               shell=True, capture_output=True)
    else:
        result = subprocess.run(
            ["lsof", "-ti", f":{port}"],
            capture_output=True, text=True,
        )
        for pid in result.stdout.strip().splitlines():
            subprocess.run(["kill", "-9", pid], capture_output=True)


def wait_for_port(port, label, timeout=60):
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


def install_backend():
    print("  [1/4] 檢查後端依賴...", end=" ", flush=True)
    req = os.path.join(BACKEND, "requirements.txt")

    dry = subprocess.run(
        [PYTHON, "-m", "pip", "install", "-r", req, "--dry-run"],
        capture_output=True, text=True,
    )

    if "would install" not in dry.stdout.lower():
        print("已就緒 ✓")
    else:
        print("安裝中...")
        subprocess.run(
            [PYTHON, "-m", "pip", "install", "-r", req, "-q"],
            cwd=BACKEND,
        )
        print("        完成 ✓")


def install_frontend():
    print("  [2/4] 檢查前端依賴...", end=" ", flush=True)
    nm = os.path.join(FRONTEND, "node_modules")
    if os.path.isdir(nm):
        print("已就緒 ✓")
    else:
        print("安裝中...")
        if os.name == "nt":
            subprocess.run(["npm", "install"], cwd=FRONTEND, shell=True)
        else:
            subprocess.run(["npm", "install"], cwd=FRONTEND)
        print("        完成 ✓")


def start_backend():
    print(f"  [3/4] 啟動後端服務 (port {BACKEND_PORT})...")

    # 清理殘留
    if is_port_open(BACKEND_PORT):
        print(f"      Port {BACKEND_PORT} 被佔用，清理中...")
        kill_port(BACKEND_PORT)
        time.sleep(1)

    if os.name == "nt":
        cmd = [PYTHON, "main.py"]
    else:
        cmd = ["sudo", PYTHON, "main.py"]

    p = subprocess.Popen(
        cmd,
        cwd=BACKEND,
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )
    procs.append(p)
    return wait_for_port(BACKEND_PORT, "後端")


def start_frontend():
    print(f"  [4/4] 啟動前端服務 (port {FRONTEND_PORT})...")

    # 清理殘留
    if is_port_open(FRONTEND_PORT):
        print(f"      Port {FRONTEND_PORT} 被佔用，清理中...")
        kill_port(FRONTEND_PORT)
        time.sleep(1)

    # 用 --port 強制指定 port，避免 Vite 跳到其他 port
    p = subprocess.Popen(
        ["npx", "vite", "--host", "--port", str(FRONTEND_PORT), "--strictPort"],
        cwd=FRONTEND,
        shell=(os.name == "nt"),
        creationflags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0,
    )
    procs.append(p)
    return wait_for_port(FRONTEND_PORT, "前端")


def cleanup():
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
    # 強制清理殘留 port
    kill_port(BACKEND_PORT)
    kill_port(FRONTEND_PORT)
    print("  已停止。再見！")


def check_admin():
    """Check if running with administrator privileges."""
    import ctypes
    try:
        return ctypes.windll.shell32.IsUserAnAdmin()
    except Exception:
        return False


def main():
    if os.name == "nt":
        os.system("title LocWarp")
    print_banner()

    # 檢查管理員權限 (iOS 17+ 需要)
    if os.name == "nt" and not check_admin():
        print("  [!] 未以系統管理員身份執行")
        print("      iOS 17+ 裝置需要管理員權限才能建立通道")
        print("      請右鍵 LocWarp.bat → 以系統管理員身份執行")
        print()

    # 檢查環境
    ok = True
    python_cmd = "python" if os.name == "nt" else "python3"
    ok = check_tool(python_cmd, "https://www.python.org/downloads/") and ok
    ok = check_tool("node", "https://nodejs.org/") and ok
    ok = check_tool("npm", "隨 Node.js 一起安裝") and ok
    print()

    if not ok:
        input("  缺少必要工具，請安裝後重試。按 Enter 離開...")
        return

    # 安裝依賴
    install_backend()
    print()
    install_frontend()
    print()

    # 啟動服務
    if not start_backend():
        print("  [錯誤] 後端啟動失敗，請查看上方錯誤訊息")
        cleanup()
        input("  按 Enter 離開...")
        return
    print()

    if not start_frontend():
        print("  [錯誤] 前端啟動失敗")
        cleanup()
        input("  按 Enter 離開...")
        return
    print()

    # 偵測本機 LAN IP（用於手機存取）
    lan_ip = "127.0.0.1"
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(("8.8.8.8", 80))
            lan_ip = s.getsockname()[0]
    except Exception:
        pass

    # 偵測 Tailscale IP（跨網路存取）
    tailscale_ip = None
    for ts_bin in [
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/usr/local/bin/tailscale",
        "/usr/bin/tailscale",
    ]:
        if os.path.isfile(ts_bin):
            try:
                result = subprocess.run(
                    [ts_bin, "ip", "-4"],
                    capture_output=True, text=True, timeout=3,
                )
                ip = result.stdout.strip().splitlines()[0].strip()
                if ip and ip.startswith("100."):
                    tailscale_ip = ip
            except Exception:
                pass
            break

    # 等待 Vite 完成首次編譯後再開瀏覽器
    time.sleep(2)
    url = f"http://localhost:{FRONTEND_PORT}"
    webbrowser.open(url)

    print("  ╔══════════════════════════════════════════╗")
    print("  ║          LocWarp 已就緒！                ║")
    print("  ╠══════════════════════════════════════════╣")
    print(f"  ║  本機:      http://localhost:{FRONTEND_PORT}        ║")
    print(f"  ║  區域網路:  http://{lan_ip}:{FRONTEND_PORT}   ║")
    if tailscale_ip:
        print(f"  ║  Tailscale: http://{tailscale_ip}:{FRONTEND_PORT}  ║")
    else:
        print( "  ║  Tailscale: (未偵測到，請確認已啟動)  ║")
    print("  ╠══════════════════════════════════════════╣")
    print("  ║  同 WiFi 用區域網路 IP，跨網路用        ║")
    print("  ║  Tailscale IP，手機加入主畫面即為 App   ║")
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
