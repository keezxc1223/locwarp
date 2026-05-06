# LocWarp

**iOS Virtual Location Simulator**, a Windows-based tool that controls an iPhone's GPS location. Supports Teleport, Navigate, Route Loop, Multi-Stop, Random Walk, and Joystick modes over USB or Wi-Fi.

<p align="right">
  <a href="README.md"><img alt="繁體中文" src="https://img.shields.io/badge/繁體中文-gray?style=flat-square"></a>
  <a href="README.en.md"><img alt="English" src="https://img.shields.io/badge/English-active-2d3748?style=flat-square"></a>
</p>

<p align="center">
  <a href="https://lin.ee/UwdCrmf" target="_blank">
    <img src="https://img.shields.io/badge/LINE-Add%20Friend-06C755?style=for-the-badge&logo=line&logoColor=white" alt="LINE" height="40">
  </a>
  &nbsp;&nbsp;
  <a href="#usdt-tip-jar-trc-20--tron-network" target="_blank">
    <img src="https://img.shields.io/badge/USDT-TRC--20-26A17B?style=for-the-badge&logo=tether&logoColor=white" alt="USDT" height="40">
  </a>
</p>

> Questions or feedback? [Reach me on LINE](https://lin.ee/UwdCrmf).  
> Want to support development? Send USDT to the address below.

### USDT tip jar (TRC-20 / TRON network)

**Wallet address**

```
TB1i7pEcifAeh8oDLLZFqiRVrpUaZmmDAn
```

**TRC-20 (TRON network) only**

<p>
  <img src="docs/donate-usdt-tron-qr.png" alt="USDT TRC-20 QR" width="260">
</p>


> ### Project Nature
>
> LocWarp is an independently-maintained open source project, not a commercial product, and without a dedicated team. The author will make reasonable efforts to add features, respond to issues, fix bugs and track iOS / pymobiledevice3 updates, however:
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
> | Major Version | Verified Versions | Status |
> | --- | --- | --- |
> | **iOS 26.x** | 26.4.2 · 26.4.1 · 26.4.1 iPadOS · 26.4 · 26.3.1 · 26.2 · 26.2.1 iPadOS (M1 iPad) | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **iOS 18.x** | 18.7.8 · 18.7.7 · 18.7.1 · 18.6.2 · 18.5 iPadOS · 18.3.1 · 18.1.1 | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **iOS 17.x** | 17.6.1 | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) |
> | **iOS 16.x** (community) | 16.7.15 · 16.7.12 ([#9](https://github.com/keezxc1223/locwarp/pull/9), @bitifyChen) | ![Reported](https://img.shields.io/badge/Reported-6c8cff?style=flat-square) ![Community](https://img.shields.io/badge/Community-ffa726?style=flat-square) |
> | **iOS 15.x and below** | n/a | ![Unsupported](https://img.shields.io/badge/Unsupported-f44336?style=flat-square) |
>
> **Note**: The table above aggregates developer-tested results and a handful of community reports. It **does not guarantee that every device on the same iOS version, network environment, or system configuration will work**. iOS virtual location stability depends on the exact iOS patch revision, pymobiledevice3's support for that revision, whether the Developer Disk Image mounts successfully, and the Windows host's driver / VPN / firewall / AV stack. "Reported" therefore means **at least one user succeeded in their specific environment**, it is not a universal compatibility claim.
>
> iOS 16+ versions not listed are not confirmed incompatible; they simply have not been reported yet. Please evaluate the risk before use. If you encounter issues, spot bugs, or confirm a version works, please open an [Issue](https://github.com/keezxc1223/locwarp/issues) so we can build up compatibility data.

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
| **Route Loop** | Loop a closed route indefinitely, with a **random 5–20 s pause** at each station (configurable) |
| **Multi-stop** | Sequentially visit waypoints, with a **random 5–20 s pause** at each stop (configurable) |
| **Random Walk** | Wander randomly within a radius, with configurable pause between legs |
| **Joystick** | Realtime direction + intensity control; supports **WASD / arrow keys** |

#### Point-to-point Jump (v0.2.96+)

Loop and Multi-stop modes have a **Point-to-point jump** checkbox. When enabled the device teleports stop-to-stop and dwells at each waypoint for a configurable interval (default 12 seconds, freely editable) instead of walking the routed path. Useful when you only need the iPhone to dwell at each waypoint in order. The setting is remembered in localStorage.

### Multi-device Group Mode (v0.2.0+, up to three devices)

Connect **up to three iPhones at once**. Every action (teleport, navigate, loop, multi-stop, random walk, joystick, pause, resume, stop, apply speed, restore-all) fans out to every connected device in parallel — both the desktop UI and the phone web control honour this.

- Device chips in the sidebar header show connection state and sim state for every device. Right-click for per-device restore / enable dev mode / disconnect.
- Status bar pills show coords, speed, mode for each device. "Restore all" wipes every device at once.
- **Auto pre-sync start**: before any group action, every device teleports to the same coordinate so they follow identical paths.
- **Random walk shared seed**: every device uses the same RNG seed, producing identical destination sequences. Runs for hours without drifting apart.
- **Cooldown is force-off in group mode**: per-device cooldowns would otherwise block fan-out actions.
- **Auto-connect**: USB watchdog polls every 1 s and auto-connects new devices up to the cap of 3. A fourth plugged-in iPhone is ignored.
- The map keeps a single-device view (all devices overlap perfectly after pre-sync, so multiple markers were just visual noise). Device identity stays visible via chips and status pills.

### Routing Source Picker (v0.2.90+ / BRouter v0.2.91+)

Below the "Use straight-line path" toggle in the mode panel, a "**Routing source**" button opens a popup that lets you switch between four free routing engines (all key-less, signup-less, no-credit-card):

| Engine | Endpoint | Notes |
| --- | --- | --- |
| **OSRM public demo** (default) | `router.project-osrm.org` | Global coverage, no key required, sometimes the whole service is down |
| **OSRM FOSSGIS** | `routing.openstreetmap.de` | Same OSRM software, different host (FOSSGIS-operated mirror) |
| **Valhalla** | `valhalla1.openstreetmap.de` | A different routing engine entirely; useful when both OSRM nodes are down |
| **BRouter** | `brouter.de` | A fourth independent engine, run by a single maintainer for years; OSM data with full bike / hike / car profiles |

The choice is persisted in localStorage. When any engine fails (502 / timeout / NoRoute), the current leg falls back to a densified straight-line and the next leg retries the engine, so a transient blip never wedges the sim. The picker is disabled when "Use straight-line path" is on (no engine call is made anyway).

### Speed Control

- **Three presets**: Walking 5 / Running 10 / Driving 40 km/h
- **Custom fixed speed**: override with any km/h value
- **Random range**: enter min–max (e.g., 40–80 km/h); backend re-picks per leg for realistic variation
- **Apply new speed mid-route**: change speed during navigate / loop / multi-stop / random-walk / joystick and press **Apply**, backend re-interpolates the remaining route from the device's current position with the new speed and continues, **no stop+restart needed**
- Status bar shows the **backend-reported active speed** (typed-but-not-applied values don't lie about what's running)
- Orange countdown banner shows on top of the map during pauses

### Phone Web Control (v0.2.96+)

Operate LocWarp from your phone without walking back to the computer. The "**Phone control**" button in the bottom status bar opens a modal showing a LAN URL and a 6-digit PIN. Open the URL in any phone browser, enter the PIN, and the phone gets a mobile-friendly map with seven actions:

> **Prerequisite**: the phone must be connected to the **same Wi-Fi network as the desktop** (cellular alone can't reach the desktop's LAN IP), and the Windows firewall must allow inbound connections to port 8777. How the desktop talks to the iPhone (USB or Wi-Fi Tunnel) doesn't matter, as long as one of them is up.

| Action | Behaviour |
| --- | --- |
| **Teleport** | Tap the map to jump there instantly |
| **Navigate-to-here** | Walk / bike / drive from the current virtual position, or set a custom km/h |
| **Search address** | Query Nominatim by name; tap a result to teleport |
| **Coord-fly** | One-line input that auto-extracts the first valid lat/lng from any pasted text (uses the same parser as the desktop) |
| **Stop / Restore** | Same semantics as the desktop buttons |

- The phone map mirrors the desktop's live blue route polyline (HTTP polling).
- Token is a random 32-hex string that's only shown in the desktop modal; PIN is 6 digits, wrong attempts get 401.
- "Regenerate" rotates the PIN + token immediately, invalidating any previously paired phone.

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

- iOS 17+ requires the **Personalized DDI** to be mounted on the iPhone for DVT (instruments → dtservicehub) to work
- Since v0.2.58 LocWarp **no longer auto-downloads or auto-mounts the DDI** (iOS 26.4.1's RSD tunnel kept getting reset during the 20 MB upload, leaving the device in an InvalidService loop). LocWarp now only checks whether the DDI is already mounted; if not, it shows a hint asking the user to mount it once externally and reconnect (see [Troubleshooting](#troubleshooting) below for tools)

### Map & Utilities

- **Recenter button** (top-left): centers the map on the current virtual position
- **Tile layer switcher** (top-right): OSM / CartoDB Voyager / ESRI Satellite / OpenFreeMap Liberty (Google-Maps-style vector tiles) / NLSC (Taiwan) / GSI (Japan)
- **Local weather**: status bar shows current weather + temp for the virtual location (Open-Meteo, animated SVG icons: breathing sun, falling rain, spinning snow, flashing lightning)
- **Country flag & timezone**: flag appears automatically after teleport; a toast warns about time-zone diff when moving across zones
- **Map pin / user avatar** (status bar):
  - Default blue-dot + 6 bundled character PNGs (rabbit / dog / cat / fox / boy / girl) + custom PNG upload
  - Uploaded PNG gets its transparent borders auto-trimmed, longest side capped at 88px, rendered at 44px on the map, bare passthrough with no added background
  - Uploaded image and the active avatar are stored in **two separate localStorage slots**, so picking a preset never wipes a previously uploaded PNG
  - Click a thumbnail to stage the change (blue highlight), hit **Save** to apply; cancel / X / clicking outside discards
  - Applies instantly on save, no teleport required to refresh the marker
- **One-click Restore** (status bar): clears the iPhone's virtual location, with "Clearing…" then "Cleared, please wait for it to take effect" toasts
- **Stop ≠ Restore**: Stop only halts movement; the simulated location stays put. Use Restore to actually clear it.
- **Bookmarks & categories**:
  - Custom coords (single-field `lat, lng` input), JSON full export / import (merge, no overwrite)
  - Auto-fills **place name** (short) and **country flag** on add (reverse geocode)
  - **Multi-select delete**, **per-category color picker** (10 presets + arbitrary HEX), search, sort (name / date / last-used)
  - "Show all on map" toggle: renders every bookmark as a neon-glass capsule pin (with flag) plus Polaroid-style cluster cards when they overlap
  - "Click also flies GPS" toggle: when ticked, clicking a bookmark teleports the iPhone (default); when unticked, only the map view pans there and the iPhone GPS stays put
  - Editing coordinates re-fetches the country flag automatically
- **Saved routes** with **GPX import / export**
- **Waypoint + route line**: subway-station style S/1/2/3 markers + animated flowing-arrow polyline for clear direction sense
- **Address search**: Nominatim by default (free); you can switch to **Google Geocoding API** in the settings panel (paste your own API key, stored locally only) for more accurate Chinese place names and POI results
- **Cooldown anti-detection**: dynamic delay based on teleport distance
- **Coordinate format switching**: DD / DMS / DM
- **Right-click menu auto-clamps**: `useLayoutEffect` measures the real menu size and nudges it inward when it would overflow the right / bottom edge

### UX

- Auto-retry on startup races (up to ~20 s window), no manual relaunch required
- Real-time WebSocket push for position, progress, ETA, remaining distance, device connection state
- Tapping a different mode tab during an active sim no longer wipes the live destination / route / waypoints from the map (v0.2.90+); switching while idle still resets to a clean slate
- Auto-reconnect on disconnect + banner auto-dismiss
- **Update check**: at startup, compares against the latest GitHub Release. When a newer version exists, a colourful animated `NEW` pill appears next to the version number in the bottom status bar (no popup interrupting your workflow); clicking the version takes you to the download page
- **Open Log Folder** button (status bar): opens `~/.locwarp/logs/` so you can attach `backend.log` to bug reports
- Current app version shown in the bottom-right corner (with a flowing-gradient `NEW` pill beside it when an update is available)
- UI language: 繁體中文 / English, switchable on the fly
- **Official LINE button** (sidebar bottom): contact the author with questions or feedback
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

### Frontend

| Tech | Version | Purpose |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 30 | Desktop shell: window management, spawn backend, tile referer injection |
| [React](https://react.dev/) | 18.3 | UI framework |
| [TypeScript](https://www.typescriptlang.org/) | 5.5 | Type-safe JS |
| [Vite](https://vitejs.dev/) | 5.4 | Dev server + production bundling (`base: './'` for `file://` loading) |
| [Leaflet](https://leafletjs.com/) | 1.9 | Interactive map (tile switcher + custom divIcon bookmark/waypoint markers + animated polyline) |
| Inline SVG | n/a | Weather icons, bookmark pins, waypoint markers, controls. Zero third-party icon sets. |
| CSS | n/a | Hand-written `styles.css`, includes all keyframe animations |

### Backend

| Tech | Version | Purpose |
| --- | --- | --- |
| Python | 3.13 | Runtime (upgraded from 3.12 in v0.2.4) |
| [FastAPI](https://fastapi.tiangolo.com/) | 0.110+ | REST API + WebSocket |
| [uvicorn](https://www.uvicorn.org/) | 0.29+ | ASGI server (`:8777`) |
| [websockets](https://websockets.readthedocs.io/) | 12+ | Real-time position / status push to frontend |
| [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) | 9.9+ | iOS device protocols (DVT / RemoteServices / lockdown / LegacyLocationService) |
| [pydantic](https://docs.pydantic.dev/) | 2+ | Request / response validation (schemas) |
| [httpx](https://www.python-httpx.org/) | 0.27+ | OSRM / OSRM FOSSGIS / Valhalla / BRouter / Nominatim / TimezoneDB HTTP calls |
| [gpxpy](https://github.com/tkrajina/gpxpy) | 1.6+ | GPX route parsing |

### Wi-Fi Tunnel (integrated into backend, v0.2.3+, iOS 17+ only)

| Tech | Purpose |
| --- | --- |
| pymobiledevice3 `start_tcp_tunnel()` | Establishes RSD tunnel (in-process asyncio task) |
| pytun-pmd3 | Windows TUN interface (wintun.dll, bundled into backend exe) |

### External Services (all free)

| Service | Caller | Purpose | Key required |
| --- | --- | --- | --- |
| [OSRM public demo](https://project-osrm.org/) | backend | Routing + `/table` multi-stop optimization (walking / driving profiles), default routing source | No |
| [OSRM FOSSGIS mirror](https://routing.openstreetmap.de/) | backend | Same OSRM engine, selectable as an alternative routing source | No |
| [Valhalla (FOSSGIS)](https://valhalla1.openstreetmap.de/) | backend | Different routing engine, third option in the routing-source picker; useful when OSRM is down | No |
| [BRouter](https://brouter.de/) | backend | Fourth independent engine, OSM data + custom routing engine, full bike / hike / car profiles | No |
| [Nominatim](https://nominatim.openstreetmap.org/) | backend | Default forward / reverse geocoding, place-name lookup (with POI-aware short_name picker) | No |
| [Google Geocoding API](https://developers.google.com/maps/documentation/geocoding) | backend | Optional secondary geocoding source (10K req/month free); user supplies their own API key in settings | Yes (user-supplied) |
| [Open-Meteo](https://open-meteo.com/) | **frontend (direct)** | Current weather at virtual location (temp + WMO weather_code); each user has their own 10,000 req/day per IP | No |
| [TimezoneDB](https://timezonedb.com/) | backend | Coords → timezone + GMT offset, cross-zone toast | Yes (bundled) |
| [flagcdn.com](https://flagcdn.com/) | frontend | Country flag PNGs (`w20/{cc}.png`, `w40/{cc}.png`) | No |
| [CartoDB Voyager](https://carto.com/) | frontend tile | Map tiles (OSM data, redistributable license) | No |
| [ESRI World Imagery](https://www.esri.com/) | frontend tile | Satellite layer (tile switcher) | No |
| [OpenFreeMap Liberty](https://openfreemap.org/) | frontend tile | Vector tiles (Google-Maps-style, rendered via MapLibre GL) | No |
| [NLSC (Taiwan)](https://maps.nlsc.gov.tw/) | frontend tile | Taiwan official basemap (government open data) | No |
| [GSI (Japan)](https://www.gsi.go.jp/) | frontend tile | Japan Geospatial Information Authority basemap | No |
| OpenStreetMap raster | frontend tile | Default OSM layer | No |
| [GitHub Releases](https://github.com/keezxc1223/locwarp/releases) | frontend | Startup version check (plain HTTP, no telemetry) | No |

### Packaging

| Tool | Purpose |
| --- | --- |
| [PyInstaller](https://pyinstaller.org/) | Python → single exe (backend, includes in-process tunnel) |
| [electron-builder](https://www.electron.build/) | Electron → NSIS installer |
| NSIS | Windows installer format |

### Core modules (backend/core/)

| Module | Responsibility |
| --- | --- |
| `simulation_engine.py` | Central controller: state transitions, task lifecycle, `_move_along_route()` movement loop, `EtaTracker` |
| `device_manager.py` | Device discovery, USB / Wi-Fi Tunnel connection management |
| `navigator.py` | Single-destination OSRM navigation |
| `route_loop.py` | Closed-route infinite loop |
| `multi_stop.py` | Multi-point sequential with dwell |
| `random_walk.py` | Random walk inside a radius |
| `joystick.py` | Real-time direction / magnitude control |
| `teleport.py` / `restore.py` | Teleport / clear virtual location |

### Key design decisions

- **WebSocket position push**: backend emits `position_update` per tick (`update_interval` is speed-profile-derived); frontend updates map cursor + ETA bar live
- **Speed resolution**: `config.resolve_speed_profile(mode, speed_kmh, speed_min_kmh, speed_max_kmh)` unifies "mode default / fixed custom / random range" inputs; priority `range > fixed > default`
- **In-process Wi-Fi tunnel**: since v0.2.3 the backend runs `start_tcp_tunnel()` on its own event loop instead of spawning a helper exe
- **Runtime state directory**: everything goes to `~/.locwarp/` (bookmarks / settings / tunnel info) to avoid PyInstaller's `_MEIPASS` temp-dir issues
- **Tile referer / OSM swap**: OSM blocks distributable apps on their public tiles, so CartoDB (OSM data hosted on CARTO's CDN, no referer needed) is the default
- **Multi-device group mode** (v0.2.0+, up to 3 devices): synchronized teleport / movement, primary is never hijacked by a late-plugged device, late joiners sync to the primary's position and auto-resume whatever sim it's running (fanout)
- **Idle-gated geocoding**: reverse geocode + timezone + weather lookups only fire when state is idle / teleport / disconnect AND position moved ≥ 100m; prevents HTTP contending with the DVT channel during active sim
- **Frontend-direct weather**: `lookupWeather()` calls Open-Meteo from the renderer so each user consumes their own IP's quota, never proxied through backend (would share one source IP across all users)
- **Auto country flag**: bookmark add / edit triggers reverse geocode to populate `country_code`; re-fetched automatically when coordinates change

---

## Prerequisites

**[Download the installer](https://github.com/keezxc1223/locwarp/releases)**

End users must complete the following four steps before use:

### 1. Install Apple USB driver

Windows needs Apple's USB driver to communicate with iPhone. **Either option works**:

- **Classic iTunes for Windows**: [iTunes for Windows (64-bit)](https://secure-appldnld.apple.com/itunes12/047-76416-20260302-fefe4356-211d-4da1-8bc4-058eb36ea803/iTunes64Setup.exe)
- **Microsoft Store iTunes**: [Store page](https://apps.microsoft.com/detail/9pb2mz1zmb1s)
- **Microsoft Store "Apple Devices"** (fallback when both iTunes builds fail): [Store page](https://apps.microsoft.com/detail/9np83lwlpz9k?hl=en-US&gl=US)

> **Note:** Install any one of the three. Most users succeed with classic desktop iTunes. If neither iTunes build (desktop or Store) detects the iPhone, community reports indicate that switching to **Apple Devices** works.

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
| `No such service: com.apple.instruments.dtservicehub` (iOS 17+/26) / LocWarp shows "DDI not mounted" | Since v0.2.58 LocWarp no longer auto-mounts the DDI. Mount it once via Xcode / 愛思助手 / 3uTools / pymobiledevice3 CLI, then reconnect. If mount still fails, toggle Settings → Privacy & Security → **Developer Mode** off, reboot, re-enable, and try mounting again. |
| **Developer Mode option missing** (iOS 16+) | Since v0.2.61, LocWarp shows a "**Reveal Developer Mode option**" button in the status bar once a device is connected. Clicking it makes the Developer Mode toggle appear in iPhone Settings (no sideloading needed). If the button fails or you prefer manual, see [Appendix: Enabling Developer Mode on iPhone (Windows)](#appendix-enabling-developer-mode-on-iphone-windows) below as a fallback. |

---

### Appendix: Enabling Developer Mode on iPhone (Windows)

On iOS 16+, **Settings → Privacy & Security → Developer Mode** is hidden by default. Apple only surfaces the toggle after a developer-signed app has been installed, or after an AMFI `reveal` command is sent to the device.

#### Primary flow (recommended, v0.2.61+)

After LocWarp connects to your device, the status bar shows a "**Reveal Developer Mode option**" button (only when the device reports Developer Mode as OFF). Clicking it asks AMFI to write the reveal marker on the iPhone. Then:

1. On the iPhone, fully close the Settings app (swipe up from the bottom)
2. Reopen Settings
3. Go to **Privacy & Security**, scroll down, you should see **Developer Mode**
4. Turn it on yourself (iPhone will ask to remove the lock-screen passcode first and reboot once)

After the toggle is on, the button disappears automatically from LocWarp.

#### Fallback flow (sideloading an IPA)

If the LocWarp button doesn't work (e.g. the device is only connected over a Wi-Fi tunnel — AMFI isn't advertised over RSD), you can still use the classic sideloading approach:

1. Install [**Sideloadly**](https://sideloadly.io/)
2. Obtain an IPA file from a decrypted IPA source such as [**Decrypt IPA Store**](https://decrypt.day/) or [**ARM Converter Decrypted App Store**](https://armconverter.com/decryptedappstore/us). A small file-manager-style app is recommended to keep sideload time short
3. Drag the IPA into the Sideloadly window
4. Connect the iPhone via USB and enter your personal Apple ID in Sideloadly
5. Press **Start** and wait for the sideload to complete
6. On the iPhone: Settings → Privacy & Security → scroll to the bottom → the **Developer Mode** toggle will now appear. Turn it on
7. The device will prompt to restart. After the reboot, verify Developer Mode is still on

Once done, return to LocWarp and connect. For iOS 17+ you also need to mount the Developer Disk Image once via Xcode / 愛思助手 / 3uTools / pymobiledevice3 CLI; LocWarp itself no longer auto-mounts (since v0.2.58).

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
