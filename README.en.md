# LocWarp

**iOS Virtual Location Simulator**, a Windows-based tool that controls an iPhone's GPS location. Supports Teleport, Navigate, Route Loop, Multi-Stop, Random Walk, and Joystick modes over USB or Wi-Fi.

<p align="right">
  <a href="README.md"><img alt="繁體中文" src="https://img.shields.io/badge/繁體中文-gray?style=flat-square"></a>
  <a href="README.en.md"><img alt="English" src="https://img.shields.io/badge/English-active-2d3748?style=flat-square"></a>
</p>

> ### Project Nature
>
> LocWarp is an independently-maintained open source hobby project, not a commercial product, and without a dedicated team. The author will make reasonable efforts to add features, respond to issues, fix bugs and track iOS / pymobiledevice3 updates, however:
>
> - Stable operation is only guaranteed in **the developer's own test environment** (currently iPhone 16 Pro Max / iOS 26.4.1 + Windows 11 Pro);
> - **Stability on other devices, iOS patch revisions, network environments or system configurations is not guaranteed**;
> - If you run into issues, please open an [Issue](https://github.com/keezxc1223/locwarp/issues) with full environment details and logs so the problem can be reproduced and addressed;
> - The project makes no commitment to perpetual maintenance, and accepts no liability for consequences arising from its use.

> ### System Requirements
>
> **Starting with v0.1.49, LocWarp only supports iOS / iPadOS 17 and later.**
>
> iOS 17+ is the primary supported range (developer-tested). **iOS 16.x is community-maintained by @bitifyChen (#9) starting from v0.2.5**, via the LegacyLocationService path; the effective minimum is iOS 16.0. iOS 15 and below remain unsupported.

> ### Compatibility Status
>
> | iOS Version | Source | Status |
> | --- | --- | --- |
> | **26.4.1** | Developer-tested | ![Verified](https://img.shields.io/badge/Verified-4caf50?style=flat-square) |
> | **26.4.1** (iPadOS) | Community-reported | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **26.4** | Community-reported | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **26.2** | Community-reported | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **26.2.1** (iPadOS, M1 iPad) | Community-reported | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **18.7.7** | Community-reported | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **18.5** (iPadOS) | Community-reported | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **18.1.1** | Community-reported | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **17.6.1** | Community-reported | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **16.7.12** (community) | @bitifyChen · [#9](https://github.com/keezxc1223/locwarp/pull/9) | ![Community](https://img.shields.io/badge/Community-ffa726?style=flat-square) |
> | **15.x and below** | n/a | ![Unsupported](https://img.shields.io/badge/Unsupported-f44336?style=flat-square) |
>
> **Note**: The table above aggregates developer-tested results and a handful of community reports. It **does not guarantee that every device on the same iOS version, network environment, or system configuration will work**. iOS virtual location stability depends on the exact iOS patch revision, pymobiledevice3's support for that revision, whether the Developer Disk Image mounts successfully, and the Windows host's driver / VPN / firewall / AV stack. "Reported" therefore means **at least one user succeeded in their specific environment**, it is not a universal compatibility claim.
>
> iOS 17+ versions not listed are not confirmed incompatible; they simply have not been reported yet. Please evaluate the risk before use. If you encounter issues, spot bugs, or confirm a version works, please open an [Issue](https://github.com/keezxc1223/locwarp/issues) so we can build up compatibility data.

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

<p align="center">
  <img src="docs/demo-v2.gif" width="720" alt="LocWarp demo">
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


### Dual-device Group Mode (v0.2.0+)

Connect **two iPhones at once**. Every action (teleport, navigate, loop, multi-stop, random walk, joystick, pause, resume, stop, apply speed, restore-all) fans out to both devices in parallel.

- Two device chips in the sidebar header show connection state and sim state. Right-click for per-device restore / enable dev mode / disconnect.
- Status bar dual pills show coords, speed, mode for each device. "Restore all" wipes both at once.
- **Auto pre-sync start**: before any group action, both devices teleport to the same coordinate so they follow identical paths.
- **Random walk shared seed**: both devices use the same RNG seed, producing identical destination sequences. Runs for hours without drifting apart.
- **Cooldown is force-off in dual mode**: per-device cooldowns would otherwise block fan-out actions.
- **Auto-connect**: USB watchdog polls every 1 s and auto-connects new devices up to the cap of 2. **A third plugged-in iPhone is completely ignored** (no Trust prompt, no connect attempt).
- The map keeps the single-device view (both devices overlap perfectly after pre-sync, so dual markers were just visual noise). Device identity stays visible via chips and status pills.

### OSRM Regional Smart Fallback (v0.2.0+)

The world is bucketed into 1° x 1° grid cells with a per-region OSRM-coverage cache. The first request to a new cell uses a 2.5 s short timeout; if it succeeds the cell is marked ok, if it fails the cell is marked down. **Uncovered regions (e.g. parts of South America or remote Africa) no longer wait 8 s per leg**, they go straight to a densified straight-line route in 0 s. Cache TTL is 10 minutes (auto re-probe in case OSRM coverage changes).

### Speed Control

- **Three presets**: Walking 5 / Running 10 / Driving 40 km/h
- **Custom fixed speed**: override with any km/h value
- **Random range**: enter min–max (e.g., 40–80 km/h); backend re-picks per leg for realistic variation
- **Apply new speed mid-route**: change speed during navigate / loop / multi-stop / random-walk / joystick and press **Apply**, backend re-interpolates the remaining route from the device's current position with the new speed and continues, **no stop+restart needed**
- Status bar shows the **backend-reported active speed** (typed-but-not-applied values don't lie about what's running)
- Orange countdown banner shows on top of the map during pauses

### Connection (iOS 16+)

- **USB**: plug in and auto-connect; screen can be locked freely
- **Wi-Fi Tunnel (USB-free mode)**:
  - "Auto Detect" first tries mDNS, then falls back to a /24 TCP scan on port 49152
  - Successful IP / Port is saved to localStorage and auto-filled next launch
  - Stopping the tunnel automatically falls back to USB if still plugged in
  - **Re-pair** button: rebuilds a damaged RemotePairing record (`~/.pymobiledevice3/`) via USB in one click (iPhone shows the Trust prompt)
- **Real-time USB hotplug detection**:
  - Unplug detected within ~4 s: drops engine + red banner + right-click menu shows "USB disconnected"
  - Re-plug auto-detected and reconnected, engine rebuilt, **no refresh needed**
- **Version check on connect**: iOS <16 devices are rejected with an explicit version + upgrade prompt

### Developer Disk Image

- iOS 17+ first-time connect auto-mounts the **Personalized DDI** (downloaded from GitHub, ~20 MB); already-mounted is a no-op
- Mount progress shown in the UI; failures surface the real error message instead of being swallowed into the log

### Map & Utilities

- **Recenter button** (bottom-left): centers the map on the current virtual position
- **One-click Restore** (status bar): clears the iPhone's virtual location, with "Clearing…" then "Cleared, please wait for it to take effect" toasts
- **Stop ≠ Restore**: Stop only halts movement; the simulated location stays put. Use Restore to actually clear it.
- **Bookmarks & categories**: custom-coordinate entries, JSON full export / import (merge, no overwrite), right-click "Copy name & coords"
- **Saved routes** with **GPX import / export**
- **Waypoint progress highlight**: during multi-stop / loop / navigate, the current target waypoint pulses orange with a ▶ icon; passed waypoints fade to grey + ✓; the start waypoint is rendered as a green "Start" tag (map markers match: S badge / numbered)
- **Address search** (Nominatim)
- **Cooldown anti-detection**: dynamic delay based on teleport distance
- **Coordinate format switching**: DD / DMS / DM

### UX

- Auto-retry on startup races (up to ~20 s window), no manual relaunch required
- Real-time WebSocket push for position, progress, ETA, remaining distance, device connection state, DDI mount progress
- **Open Log Folder** button (status bar): opens `~/.locwarp/logs/` so you can attach `backend.log` to bug reports
- Current app version shown in the bottom-right corner
- UI language: 繁體中文 / English, switchable on the fly
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
- **Backend**: Python 3.13, FastAPI, uvicorn, websockets
- **iOS control**: [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) (DVT / RemoteServices / lockdown)
- **Wi-Fi Tunnel**: runs in-process inside the backend event loop (v0.2.3+; previously a standalone Python 3.13 helper)
- **External services**: [OSRM](https://project-osrm.org/) (routing), [Nominatim](https://nominatim.openstreetmap.org/) (geocoding), [CartoDB Voyager](https://carto.com/) (map tiles)

---

## Prerequisites

**[Download the installer](https://github.com/keezxc1223/locwarp/releases)**

End users must complete the following four steps before use:

### 1. Install iTunes for Windows

Windows needs Apple's USB driver to communicate with iPhone.

- **Required download**: [iTunes for Windows (64-bit)](https://secure-appldnld.apple.com/itunes12/047-76416-20260302-fefe4356-211d-4da1-8bc4-058eb36ea803/iTunes64Setup.exe)

> **Note:** Do **not** use "Apple Devices" from the Microsoft Store, it is **incompatible** and LocWarp will not detect the device. You must install the classic iTunes linked above.

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
| **USB** | ![Yes](https://img.shields.io/badge/Lockable-4caf50?style=flat-square) Can lock screen freely | n/a |
| **Wi-Fi Tunnel** | ![No](https://img.shields.io/badge/Not_Lockable-f44336?style=flat-square) Lock-screen drops the tunnel | Disable auto-lock during use |

> **Note:** **Under Wi-Fi Tunnel, locking the iPhone's screen will cause the network interface to sleep and drop the RSD tunnel.**
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
- Python **3.13** (backend + Wi-Fi tunnel; required for TLS-PSK)
- Node.js 18+

### Setup

```bash
# 1. Backend dependencies (includes Wi-Fi tunnel)
py -3.13 -m pip install -r backend/requirements.txt

# 2. Frontend dependencies
cd frontend
npm install
```

### Run (dev mode)

Double-click `LocWarp.bat`, it auto-elevates and invokes `start.py`, which launches:
- backend (`:8777`)
- Vite dev server (`:5173`)
- Electron (loading from the dev server)

---

## Build Installer

### One-time setup

```bash
py -3.13 -m pip install pyinstaller
cd frontend && npm install -D electron-builder
```

### One-shot build

```bash
build-installer.bat
```

Pipeline:
1. **PyInstaller (3.13)** → `dist-py/locwarp-backend/` (backend + embedded WiFi tunnel)
2. **Vite** → `frontend/dist/`
3. **electron-builder** → NSIS installer `frontend/release/LocWarp Setup X.Y.Z.exe` (~110 MB)

The installer is self-contained, end users need no Python or Node installed.

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Backend unreachable after tunnel started | Make sure LocWarp was launched as Administrator |
| `No such service: com.apple.instruments.dtservicehub` (iOS 17+/26) | LocWarp auto-mounts the Developer Disk Image. If it still fails: (1) Settings → Privacy & Security → **Developer Mode** off, reboot, turn it back on; (2) make sure github.com is reachable (DDI is downloaded from there, ~20 MB); (3) unplug and reconnect the device. Since v0.1.34 LocWarp also falls back to the legacy `com.apple.dt.simulatelocation` service automatically. |
| DDI download hangs / times out | Check that github.com / raw.githubusercontent.com is reachable, some corporate or campus networks block it. |
| **Developer Mode option missing** (iOS 16+) | The device must have had a signed app deployed to it before the option appears in Settings. See [Appendix: Enabling Developer Mode on iPhone (Windows)](#appendix-enabling-developer-mode-on-iphone-windows) below. |

---

### Appendix: Enabling Developer Mode on iPhone (Windows)

On iOS 16+, **Settings → Privacy & Security → Developer Mode** is hidden by default. Apple only surfaces the toggle after the device has been deployed to by a developer-signed app at least once. Windows users can trigger this by sideloading any self-signed IPA:

1. Install [**Sideloadly**](https://sideloadly.io/).
2. Obtain an IPA file from a decrypted IPA source such as [**Decrypt IPA Store**](https://decrypt.day/) or [**ARM Converter Decrypted App Store**](https://armconverter.com/decryptedappstore/us). A small file-manager-style app is recommended to keep sideload time short.
3. Drag the IPA into the Sideloadly window.
4. Connect the iPhone via USB and enter your personal Apple ID in Sideloadly.
5. Press **Start** and wait for the sideload to complete.
6. On the iPhone: Settings → Privacy & Security → scroll to the bottom → the **Developer Mode** toggle will now appear. Turn it on.
7. The device will prompt to restart. After the reboot, verify Developer Mode is still on.

Once done, return to LocWarp and connect. On first connection LocWarp will download and mount the Developer Disk Image automatically if needed.

> Procedure adapted from community feedback, thanks for sharing.

---

## License

Released under the **MIT License**, see [LICENSE](LICENSE).

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
