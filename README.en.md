# LocWarp

**iOS Virtual Location Simulator** — a Windows-based tool that controls an iPhone's GPS location. Supports Teleport, Navigate, Route Loop, Multi-Stop, Random Walk, and Joystick modes over USB or Wi-Fi.

<p align="right">
  <a href="README.md"><img alt="繁體中文" src="https://img.shields.io/badge/繁體中文-gray?style=flat-square"></a>
  <a href="README.en.md"><img alt="English" src="https://img.shields.io/badge/English-active-2d3748?style=flat-square"></a>
</p>

> ### Compatibility Status
>
> | iOS Version | Source | Status |
> | --- | --- | --- |
> | **26.4.1** | Developer-tested | ✅ Verified working |
> | **26.4** | Community-reported | ✅ Reported working |
> | **18.1.1** | Community-reported | ✅ Reported working |
>
> Other versions are untested — please evaluate compatibility before use. Whether things work, break, or you have ideas for improvement, feedback is welcome in [Issues](https://github.com/keezxc1223/locwarp/issues).

<p align="center">
  <img src="frontend/build/icon.png" width="128" alt="LocWarp">
</p>

<p align="center">
  <a href="#prerequisites">
    <img alt="User Guide" src="https://img.shields.io/badge/User_Guide-2d3748?style=for-the-badge&logo=readthedocs&logoColor=white">
  </a>
  <a href="https://github.com/keezxc1223/locwarp/releases">
    <img alt="Download" src="https://img.shields.io/badge/Download-4285f4?style=for-the-badge&logo=github&logoColor=white">
  </a>
</p>


---

## Features

### Movement Modes

| Mode | Description |
| --- | --- |
| **Teleport** | Instantly jump to a coordinate |
| **Navigate** | Walk / run / drive along an OSRM route to a destination |
| **Route Loop** | Loop a closed route indefinitely, with a **random 5–20 s pause** each lap |
| **Multi-stop** | Sequentially visit waypoints, with a **random 5–20 s pause** at each stop (configurable) |
| **Random Walk** | Wander randomly within a radius, with configurable pause between legs |
| **Joystick** | Realtime direction + intensity control; supports **WASD / arrow keys** |

### Speed Control

- **Three presets**: Walking 5 / Running 10 / Driving 40 km/h
- **Custom fixed speed**: override with any km/h value
- **Random range**: enter min–max (e.g., 40–80 km/h); backend re-picks per leg for realistic variation
- Status bar reflects the active speed (range > custom > preset)
- Orange countdown banner shows on top of the map during pauses

### Connection

- **USB**: plug in and auto-connect; screen can be locked freely
- **Wi-Fi Tunnel (iOS 17+)**:
  - "Auto Detect" first tries mDNS, then falls back to a /24 TCP scan on port 49152
  - Successful IP / Port is saved to localStorage and auto-filled next launch
  - Stopping the tunnel automatically falls back to USB if still plugged in
- **iOS 16 and below**: legacy direct-IP WiFi connection (no RSD tunnel needed)
- Wi-Fi panel is collapsible with iOS-version tabs

### Map & Utilities

- **Recenter button** (bottom-left): centers the map on the current virtual position
- **One-click Restore** (status bar): clears the iPhone's virtual location with toast confirmation
- **Bookmarks & categories**, **saved routes**, **address search** (Nominatim)
- **Cooldown anti-detection**: dynamic delay based on teleport distance
- **Coordinate format switching**: DD / DMS / DM

### UX

- Auto-retry on startup races (up to ~20 s window) — no manual relaunch required
- Real-time WebSocket push for position, progress, ETA, remaining distance
- All state (bookmarks, settings, tunnel info) lives in `~/.locwarp/`

---

## Architecture

```
┌─────────────────┐      IPC / HTTP + WS       ┌──────────────────┐
│ Electron + React│ ─────────────────────────► │ FastAPI backend  │
│  (port 5173 dev)│ ◄───────────────────────── │  (port 8777)     │
└─────────────────┘                            └────────┬─────────┘
                                                        │ pymobiledevice3
                                                        ▼
                                              ┌──────────────────┐
                                              │ iPhone (USB/Wi-Fi)│
                                              └──────────────────┘
```

### Stack

- **Frontend**: Electron 30, React 18.3, TypeScript 5.5, Vite 5.4, Leaflet 1.9
- **Backend**: Python 3.12, FastAPI, uvicorn, websockets
- **iOS control**: [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) (DVT / RemoteServices / lockdown)
- **Wi-Fi Tunnel helper**: standalone Python 3.13 helper (TLS-PSK support)
- **External services**: [OSRM](https://project-osrm.org/) (routing), [Nominatim](https://nominatim.openstreetmap.org/) (geocoding), [CartoDB Voyager](https://carto.com/) (map tiles)

---

## Prerequisites

**[Download the installer](https://github.com/keezxc1223/locwarp/releases)**

End users must complete the following four steps before use:

### 1. Install iTunes for Windows

Windows needs Apple's USB driver to communicate with iPhone.

- **Required download**: [iTunes for Windows (64-bit)](https://secure-appldnld.apple.com/itunes12/047-76416-20260302-fefe4356-211d-4da1-8bc4-058eb36ea803/iTunes64Setup.exe)

> ⚠ Do **not** use "Apple Devices" from the Microsoft Store — it is **incompatible** and LocWarp will not detect the device. You must install the classic iTunes linked above.

### 2. Trust the computer via USB first

On first use, connect the iPhone via USB. When prompted "Trust this computer?", tap **Trust** and enter the passcode. This creates a pair record so that LocWarp can communicate with the device afterwards.

### 3. Enable Developer Mode (iOS 16+)

On iPhone: **Settings → Privacy & Security → Developer Mode → Enable**

The device will reboot. After restart, confirm "Turn On Developer Mode?" when prompted.

### 4. Wi-Fi Tunnel (optional)

To disconnect the USB cable and operate over Wi-Fi:
- iPhone and the computer must be on the **same Wi-Fi subnet**
- Step 2 (USB pairing) must still be completed first
- Click **Start Wi-Fi Tunnel** in LocWarp to establish the RSD tunnel; the USB cable may then be unplugged

#### Connection mode differences

| Method | Lock-screen impact | Recommendation |
| --- | --- | --- |
| **USB** | ✔ Can lock screen freely | — |
| **Wi-Fi Tunnel** | ✘ Screen lock causes the network interface to sleep, dropping the tunnel | Disable auto-lock during use |

> ⚠ **Under Wi-Fi Tunnel, locking the iPhone's screen will cause the network interface to sleep and drop the RSD tunnel.**
>
> Mitigations (any one works):
> - **Disable auto-lock**: Settings → Display & Brightness → Auto-Lock → **Never**
> - Keep a LocWarp-related screen in the foreground (prevents low-power mode)
> - Plug in a charger and keep the display on
>
> USB users are unaffected and can lock the screen normally without interrupting simulation.

After installation, LocWarp will appear on the desktop and Start Menu. It requires administrator privileges on launch (necessary for the Wi-Fi Tunnel's TUN interface).

---

## Development

### Prerequisites

- Windows 10 / 11
- Python **3.12** (backend)
- Python **3.13** (Wi-Fi tunnel; required for TLS-PSK)
- Node.js 18+

### Setup

```bash
# 1. Backend dependencies
py -3.12 -m pip install -r backend/requirements.txt

# 2. Wi-Fi tunnel dependencies (Python 3.13)
py -3.13 -m pip install pymobiledevice3

# 3. Frontend dependencies
cd frontend
npm install
```

### Run (dev mode)

Double-click `LocWarp.bat` — it auto-elevates and invokes `start.py`, which launches:
- backend (`:8777`)
- Vite dev server (`:5173`)
- Electron (loading from the dev server)

---

## Build Installer

### One-time setup

```bash
py -3.12 -m pip install pyinstaller
py -3.13 -m pip install pyinstaller pymobiledevice3
cd frontend && npm install -D electron-builder
```

### One-shot build

```bash
build-installer.bat
```

Pipeline:
1. **PyInstaller (3.12)** → `dist-py/locwarp-backend/`
2. **PyInstaller (3.13)** → `dist-py/wifi-tunnel/`
3. **Vite** → `frontend/dist/`
4. **electron-builder** → NSIS installer `frontend/release/LocWarp Setup X.Y.Z.exe` (~140 MB)

The installer is self-contained — end users need no Python or Node installed.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Backend unreachable after tunnel started | Make sure LocWarp was launched as Administrator |

---

## License

Released under the **MIT License** — see [LICENSE](LICENSE).

Free for use, modification, redistribution, and commercial use, provided the original copyright and license notice are retained.

---

## Disclaimer

### 1. Academic & Research Use Only

This project is intended for GIS research, mobile-app development testing, location-service prototyping, and related technical exploration. Do not use it for any unlawful purpose or in violation of third-party service terms.

### 2. Account Ban Risk

LocWarp simulates GPS signals via Apple's DVT / RemoteServices protocol through pymobiledevice3. Using it with location-based games (e.g., Pokémon GO, Ingress, Monster Hunter Now) or with social, check-in, or logistics apps may violate those platforms' terms of service and result in warnings, restrictions, or permanent bans. **The developer is not responsible for any account loss, virtual-property damage, or derivative disputes arising from the use of this tool.**

### 3. System & Hardware Risk

Wi-Fi Tunnel mode requires administrator privileges to create a TUN virtual network interface and negotiate the RSD (Remote Service Discovery) channel with the iOS device. While the code has been internally tested, no guarantee is made that it runs stably under all Windows versions, hardware combinations, or network environments. Known edge cases include:

- Conflicts with VPN software, third-party firewalls, or network virtualization tools preventing the tunnel from starting
- A stale TUN interface left behind after abnormal termination, requiring a system restart to clean up
- Connection drops that require a manual retry or application restart

Users bear any consequences resulting from the above. The project only manipulates its own transient network interfaces and its own configuration files (located in `~/.locwarp/`). **It does not modify any user data inside the iOS device, nor alter OS core files or existing device pair records.**

### 4. Map Data Accuracy

LocWarp uses Leaflet on the frontend, tiles served by an OpenStreetMap-derived provider (CartoDB), and OSRM + Nominatim for routing and geocoding. Coordinates, routes, and addresses are **for reference only**. The developer does not guarantee completeness, real-time accuracy, or exact correspondence to real-world geography. Before relying on address search, route navigation, or random-walk results for simulation, users should verify that the displayed data matches expectations.

### 5. User Responsibility

Users must comply with the laws and regulations of their jurisdiction, including but not limited to personal-data protection laws, computer-data processing laws, and copyright laws. Any legal dispute, civil liability, or criminal responsibility arising from misuse or unlawful use of this tool is borne solely by the user; the developer and contributors bear no responsibility.

---

**By downloading, installing, or running this software, you acknowledge that you have read and agreed to all of the above. If you do not agree, stop using the software and remove it immediately.**
