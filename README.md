# LocWarp

**iOS 虛擬定位模擬器**, 在 Windows 上控制 iPhone 的 GPS 定位,支援直接跳點、導航、路線循環、多點停留、隨機漫步、搖桿操作等模擬模式,可經由 USB 或 WiFi 連線。

<p align="right">
  <a href="README.md"><img alt="繁體中文" src="https://img.shields.io/badge/繁體中文-active-2d3748?style=flat-square"></a>
  <a href="README.en.md"><img alt="English" src="https://img.shields.io/badge/English-gray?style=flat-square"></a>
</p>

> ### 專案性質聲明
>
> LocWarp 為個人獨立維護之開源專案(hobby project),非商業產品,亦無專職團隊。開發者將盡力於合理時間內新增功能、回應 Issue、修復 Bug 並隨 iOS / pymobiledevice3 版本演進持續更新,然:
>
> - 本專案僅保證**於開發者本人測試環境**(目前為 iPhone 16 Pro Max / iOS 26.4.1 + Windows 11 專業版)下運作正常;
> - **不保證於其他裝置、iOS 修補版本、網路環境、系統配置下皆能穩定使用**;
> - 若遇到問題,歡迎至 [Issues](https://github.com/keezxc1223/locwarp/issues) 提交完整環境資訊與日誌,以協助定位與改善;
> - 本專案不保證永續維護,亦不承擔因使用本工具所生之任何責任。

> ### 系統需求
>
> **LocWarp 自 v0.1.49 起僅支援 iOS / iPadOS 17 以上的裝置。**
>
> iOS 16 及更早版本因 Developer Disk Image 機制差異與多位使用者實測無法正常運作,已停止支援;若連接 iOS <17 裝置,LocWarp 會直接拒絕並顯示提示。

> ### 相容性測試狀態
>
> | iOS 版本 | 驗證來源 | 狀態 |
> | --- | --- | --- |
> | **26.4.1** | 開發者實測 | ![Tested](https://img.shields.io/badge/測試可用-4caf50?style=flat-square) |
> | **26.4** | 社群使用者回報 | ![Reported](https://img.shields.io/badge/回報可用-6c8cff?style=flat-square) |
> | **26.2.1**(iPadOS,M1 iPad) | 社群使用者回報 | ![Reported](https://img.shields.io/badge/回報可用-6c8cff?style=flat-square) |
> | **18.7.7** | 社群使用者回報 | ![Reported](https://img.shields.io/badge/回報可用-6c8cff?style=flat-square) |
> | **18.5**(iPadOS) | 社群使用者回報 | ![Reported](https://img.shields.io/badge/回報可用-6c8cff?style=flat-square) |
> | **18.1.1** | 社群使用者回報 | ![Reported](https://img.shields.io/badge/回報可用-6c8cff?style=flat-square) |
> | **17.6.1** | 社群使用者回報 | ![Reported](https://img.shields.io/badge/回報可用-6c8cff?style=flat-square) |
> | **16.x 及以下** | n/a | ![Unsupported](https://img.shields.io/badge/不支援-f44336?style=flat-square) |
>
> **說明**:上表僅彙整開發者實測與少數社群回饋的結果,**並不保證於所有相同版本的裝置、網路環境或系統組合下皆能正常運作**。iOS 虛擬定位的穩定性高度依賴 iOS 修補版本、pymobiledevice3 對該版本的支援程度、Developer Disk Image 是否成功掛載,以及 Windows 端的驅動、VPN、防火牆、AV 配置。因此「回報可用」僅代表**至少一位使用者在其特定環境下成功運作**,不等同於通用相容性聲明。
>
> 未列於上表的 iOS 17+ 版本並非確定不相容,僅表示尚未收到回報。使用前請自行評估風險,若遇到問題、發現 Bug 或確認某版本可用,歡迎至 [Issues](https://github.com/keezxc1223/locwarp/issues) 提出以協助累積相容性資料。

<p align="center">
  <img src="frontend/build/icon.png" width="128" alt="LocWarp">
</p>

<p align="center">
  <a href="#使用者端需求">
    <img alt="使用者端說明" src="https://img.shields.io/badge/使用者端說明-2d3748?style=for-the-badge&logo=readthedocs&logoColor=white">
  </a>
  <a href="https://github.com/keezxc1223/locwarp/releases">
    <img alt="下載安裝檔" src="https://img.shields.io/badge/下載安裝檔-4285f4?style=for-the-badge&logo=github&logoColor=white">
  </a>
</p>

<p align="center">
  <img src="docs/demo-v2.gif" width="720" alt="LocWarp demo">
</p>

---

## 功能

### 移動模式

| 模式 | 說明 |
| --- | --- |
| **Teleport** | 瞬間跳到指定座標 |
| **Navigate** | 從目前位置沿 OSRM 路線步行/跑步/開車到目的地 |
| **Route Loop** | 無限循環指定路線,**每圈隨機 5~20 秒停頓** |
| **Multi-stop** | 依序經過多個停靠點,**每點隨機 5~20 秒停頓**(可自訂) |
| **Random Walk** | 在指定半徑內隨機漫遊,每段停頓時間可調 |
| **Joystick** | 以方向 + 力度即時操控,支援 **WASD / 方向鍵** 鍵盤操作 |


### 雙裝置群組模式 (v0.2.0+)

可同時連接 **兩台 iPhone**,所有操作 (瞬移、導航、巡迴、多點導航、隨機漫步、搖桿、暫停、繼續、停止、套用速度、全部還原) 會**同步發送**到兩台。

- 側邊欄頂端兩個裝置 chip 顯示連線狀態與目前模式;右鍵選單可單獨還原 / 開發者模式 / 中斷該台
- 底部狀態列雙 pill 並陳兩台座標、速度、模式;「全部還原」一鍵清除兩台虛擬定位
- **自動同步起點**:啟動任何群組動作前先把兩台瞬移到同座標,確保兩台路徑一致
- **隨機漫步共用亂數種子**:兩台目的地序列完全相同,跑幾小時也不會脫鉤
- **冷卻 toggle 自動鎖定為關閉**:避免兩台同步動作互相阻擋
- **自動連線**:USB 偵測到新裝置 1 秒內自動配對,直到 2 台上限,**第三台插上完全不理**
- 地圖維持單一視覺 (兩台已永遠重疊,雙 marker 反而是雜訊),裝置狀態靠 chip 與 StatusBar pill 呈現

### OSRM 區域智慧 fallback (v0.2.0+)

把世界切成 1° × 1° 網格快取 OSRM 覆蓋狀態:首次到新區域用 2.5 秒 short-timeout 試打 OSRM,通了標 ok、不通標 down。下次同區直接看快取,**沒覆蓋的區域 (例如部分南美 / 非洲偏遠地帶) 不再每段都白等 8 秒 timeout**,直接走密化直線。10 分鐘 TTL 過期會重 probe 一次。

### 速度控制

- **預設三檔**:走路 5 / 跑步 10 / 開車 40 km/h
- **自訂固定速度**:輸入任意 km/h 覆蓋模式預設
- **隨機範圍**:輸入 min ~ max(例如 40 ~ 80 km/h),後端每段路重抽,模擬真實路況
- **路線中即時套用新速度**:導航 / 巡迴 / 多點 / 隨機漫步 / 搖桿模式進行中可修改速度後按「**套用新速度**」,後端從當前位置以新速度重算剩餘路段並接續執行,**不需停下重來**
- 狀態列顯示**後端實際生效**的速度(輸入新值未套用前不會誤顯示)
- 到點/到圈暫停時,地圖上方顯示橘色倒數橫幅

### 連線方式(iOS 17+)

- **USB 有線**:插上即自動連線,鎖屏不影響
- **WiFi Tunnel(USB 拔除模式)**:
  - 按「自動偵測」→ 先 mDNS 廣播 → 失敗自動退回 /24 TCP 掃描 port 49152
  - 成功連線的 IP / Port 記到 localStorage,下次自動預填
  - 停止 Tunnel 後若 USB 仍插著,**自動切回 USB 模式**
  - 「**重新配對**」按鈕:RemotePairing 記錄損毀時可一鍵透過 USB 重建 `~/.pymobiledevice3/`(iPhone 會跳信任提示)
- **USB 即時熱插拔偵測**:
  - 拔除 USB 約 4 秒內偵測,清除 engine + 廣播紅色橫幅 + 右鍵選單顯示「USB 已斷開」
  - 重新插上自動偵測 + 重新連線 + 重建 engine,**不必重新整理**
- **連線時版本檢查**:iOS <17 直接拒絕並顯示具體版本與升級提示

### Developer Disk Image

- iOS 17+ 首次連線會自動偵測 + 下載並掛載 **Personalized DDI**(從 GitHub 約 20 MB),已掛載則直接 no-op
- DDI 掛載中前端顯示 overlay,失敗時把真實錯誤訊息顯示到 UI(不再吃進 log)

### 地圖與輔助

- **定位按鈕**:左下角,一鍵將地圖置中到目前虛擬位置
- **一鍵還原**:狀態列,清除 iPhone 虛擬定位並顯示「正在清除 / 已清除請等待生效」提示
- **停止 ≠ 還原**:停止只結束移動,虛擬定位保留;清除請按「一鍵還原」
- **座標收藏 / 分類**:支援自訂座標、JSON 全量匯出 / 匯入(合併,不覆蓋)、右鍵複製名稱與座標
- **儲存路線 + GPX 匯入 / 匯出**
- **路徑點高亮**:多點 / 巡迴 / 導航中,目前目標路徑點以橘色脈動邊框 + ▶ 圖示;已抵達淡化為灰 + ✓;起點以綠色「起點」標籤顯示(地圖標記同步 S/數字編號)
- **地址搜尋**(Nominatim)
- **Cooldown 防偵測**:依跳點距離動態延遲,避免異常偵測
- **座標格式切換**:DD / DMS / DM

### 使用者體驗

- 啟動時 backend race condition 自動重試(最多 ~20 秒緩衝),無需手動重開
- WebSocket 即時推播位置、進度、ETA、剩餘距離、裝置連線狀態、DDI 掛載進度
- **Log 資料夾**按鈕(狀態列):一鍵開啟 `~/.locwarp/logs/` 資料夾,方便將 backend.log 附到 Issue
- 右下角顯示**目前 App 版本**
- 介面語言:繁體中文 / English 即時切換
- 所有狀態(座標收藏、設定、tunnel 資訊)寫在 `~/.locwarp/`

---

## 架構

```
┌─────────────────┐      IPC / HTTP + WS       ┌──────────────────┐
│ Electron + React│ ─────────────────────────► │ FastAPI backend  │
│  (port 5173 dev)│ ◄───────────────────────── │  (port 8777)     │
└─────────────────┘                            └────────┬─────────┘
                                                        │ pymobiledevice3
                                                        ▼
                                              ┌──────────────────┐
                                              │ iPhone (USB/WiFi)│
                                              └──────────────────┘
```

### Frontend

| 技術 | 版本 | 用途 |
| --- | --- | --- |
| [Electron](https://www.electronjs.org/) | 30 | Desktop shell,負責視窗管理、spawn backend、注入 tile referer |
| [React](https://react.dev/) | 18.3 | UI framework |
| [TypeScript](https://www.typescriptlang.org/) | 5.5 | Type-safe JS |
| [Vite](https://vitejs.dev/) | 5.4 | Dev server + 生產環境打包(`base: './'` 供 `file://` 載入) |
| [Leaflet](https://leafletjs.com/) | 1.9 | 互動地圖 |
| CSS | n/a | 手寫,單一 `styles.css` |

### Backend

| 技術 | 版本 | 用途 |
| --- | --- | --- |
| Python | 3.12 | 主 runtime |
| [FastAPI](https://fastapi.tiangolo.com/) | 0.110+ | REST API + WebSocket |
| [uvicorn](https://www.uvicorn.org/) | 0.29+ | ASGI server(`:8777`) |
| [websockets](https://websockets.readthedocs.io/) | 12+ | 即時位置/狀態推播給前端 |
| [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) | 9.9+ | iOS 裝置協議(DVT / RemoteServices / lockdown) |
| [pydantic](https://docs.pydantic.dev/) | 2+ | 資料驗證(schemas) |
| [httpx](https://www.python-httpx.org/) | 0.27+ | OSRM / Nominatim HTTP 呼叫 |
| [gpxpy](https://github.com/tkrajina/gpxpy) | 1.6+ | GPX 路線解析 |

### WiFi Tunnel(獨立 helper)

| 技術 | 版本 | 用途 |
| --- | --- | --- |
| Python | **3.13**(必需) | TLS-PSK 原生支援(3.12 不行) |
| pymobiledevice3 | 9.9+ | `start_tcp_tunnel()` 建立 RSD tunnel |
| pytun-pmd3 | n/a | Windows TUN 介面(wintun.dll) |

### 外部服務(皆免費、無需 API key)

| 服務 | 用途 |
| --- | --- |
| [OSRM](https://project-osrm.org/)(`router.project-osrm.org`) | 路線規劃(walking / driving profile) |
| [Nominatim](https://nominatim.openstreetmap.org/) | 地址 → 座標查詢 |
| [CartoDB Voyager](https://carto.com/) | 地圖底圖 tile(OSM 資料,免費散佈授權) |

### 打包工具

| 工具 | 用途 |
| --- | --- |
| [PyInstaller](https://pyinstaller.org/) | Python → 單檔 exe(backend 用 3.12,tunnel 用 3.13) |
| [electron-builder](https://www.electron.build/) | Electron 打包成 NSIS 安裝檔 |
| NSIS | Windows 安裝器 |

### 核心模組(backend/core/)

| 模組 | 職責 |
| --- | --- |
| `simulation_engine.py` | 中央控制器,管理狀態轉換、任務生命週期、`_move_along_route()` 核心移動迴圈、`EtaTracker` |
| `device_manager.py` | 裝置探索、USB / WiFi Tunnel 連線管理 |
| `navigator.py` | 單一目的地 OSRM 導航 |
| `route_loop.py` | 封閉路線無限循環 |
| `multi_stop.py` | 多點依序經過,可停留 |
| `random_walk.py` | 在半徑內隨機漫遊 |
| `joystick.py` | 即時方向/力度控制 |
| `teleport.py` / `restore.py` | 瞬移 / 恢復 |

### 關鍵設計

- **WebSocket 位置推播**:backend 每 tick(`update_interval` 由速度 profile 決定)發 `position_update` 事件,前端即時更新地圖游標 + ETA bar
- **速度解析**:`config.resolve_speed_profile(mode, speed_kmh, speed_min_kmh, speed_max_kmh)` 統一處理「模式預設 / 固定自訂 / 隨機範圍」三種輸入,優先序 `range > 固定 > 預設`
- **打包後路徑偵測**:backend 以 `sys.frozen` 判斷是否 PyInstaller bundle,從 `resources/backend/` 反推 `resources/wifi-tunnel/wifi-tunnel.exe`,避免硬編碼路徑
- **Runtime 狀態目錄**:一律寫入 `~/.locwarp/`(bookmarks / settings / tunnel info),避免 PyInstaller 的 `_MEIPASS` 臨時目錄問題
- **Tile referer / OSM 替換**:OSM 的 tile 服務封鎖散佈型應用,已改用 CartoDB(OSM 資料源、CARTO 代管 CDN、免 referer)

---

## 開發環境

### 先決條件

- Windows 10 / 11
- Python **3.12**(backend)
- Python **3.13**(WiFi tunnel,TLS-PSK 需求)
- Node.js 18+
- iPhone 已透過 iTunes / Apple Devices 配對過這台電腦
- iOS 17+ 需開啟「開發人員模式」

### 首次設置

```bash
# 1. 後端依賴
py -3.12 -m pip install -r backend/requirements.txt

# 2. WiFi tunnel 依賴(Python 3.13)
py -3.13 -m pip install pymobiledevice3

# 3. 前端依賴
cd frontend
npm install
```

### 啟動(開發模式)

雙擊 `LocWarp.bat`, 會自動提權並呼叫 `start.py`,同時啟動:
- backend(`:8777`)
- Vite dev server(`:5173`)
- Electron(載入 dev server)

或手動:

```bash
# 終端 1, backend
cd backend && py -3.12 main.py

# 終端 2, 前端 + Electron
cd frontend && npm run start
```

---

## 打包(產出安裝檔)

### 一次性安裝打包工具

```bash
py -3.12 -m pip install pyinstaller
py -3.13 -m pip install pyinstaller pymobiledevice3
cd frontend && npm install -D electron-builder
```

### 一鍵建置

```bash
build-installer.bat
```

依序執行:
1. **PyInstaller(3.12)** 編譯 backend → `dist-py/locwarp-backend/`
2. **PyInstaller(3.13)** 編譯 wifi-tunnel → `dist-py/wifi-tunnel/`
3. **Vite** 建置前端 → `frontend/dist/`
4. **electron-builder** 產出 NSIS 安裝檔 → `frontend/release/LocWarp Setup 0.1.0.exe`(~140 MB)

產物為單一 exe,使用者無需安裝 Python / Node / 任何套件。

---

## 使用者端需求

**[下載安裝檔](https://github.com/keezxc1223/locwarp/releases)**

使用安裝檔的使用者需要以下四項前置:

### 1. 安裝 iTunes for Windows

Windows 需要 Apple 的 USB driver 才能與 iPhone 溝通。

- **下載(必裝)**:[iTunes for Windows (64-bit)](https://secure-appldnld.apple.com/itunes12/047-76416-20260302-fefe4356-211d-4da1-8bc4-058eb36ea803/iTunes64Setup.exe)

> **注意:** 請勿使用 Microsoft Store 的「Apple Devices」, 該版本**不相容**,LocWarp 會抓不到裝置。必須裝上面連結的傳統版 iTunes。

### 2. USB 連接並信任此電腦

首次使用前,用 USB 線接上 iPhone,iPhone 會跳「要信任這部電腦嗎?」,點 **信任** 並輸入密碼。這會產生 pair record,後續 LocWarp 才能與裝置通訊。

### 3. 開啟開發人員模式(iOS 17+)

iPhone 上:**設定 → 隱私權與安全性 → 開發者模式 → 開啟**

開啟後裝置會要求重啟。重啟後會再次確認「啟用開發者模式?」,點啟用。

### 4. WiFi Tunnel(選用)

若要拔掉 USB 改走無線連線:
- iPhone 與電腦必須在**同一個 WiFi 網段**
- 第一次仍需要先用 USB 配對過(步驟 2)
- LocWarp 內按 **Start WiFi Tunnel** 會建立 RSD tunnel,之後 USB 可拔除

#### 連線模式差異

| 連線方式 | 鎖屏影響 | 建議設定 |
| --- | --- | --- |
| **USB 有線** | ![Yes](https://img.shields.io/badge/可鎖屏-4caf50?style=flat-square) 可自由鎖定螢幕 | n/a |
| **WiFi Tunnel** | ![No](https://img.shields.io/badge/不可鎖屏-f44336?style=flat-square) 鎖屏會導致網路介面休眠,Tunnel 中斷 | 建議關閉自動鎖定以維持連線 |

> **注意:** **WiFi Tunnel 模式下 iPhone 螢幕熄滅會造成網路介面進入休眠狀態,導致 RSD Tunnel 中斷連線。**
>
> 建議執行以下任一設定以避免連線中斷:
> - **關閉自動鎖定**:設定 → 顯示與亮度 → 自動鎖定 → **永不**
> - **保持 LocWarp 相關畫面於前景執行**(避免系統進入低功耗模式)
> - **連接充電線並維持螢幕常亮**
>
> 若僅透過 USB 連線使用,則無此限制,iPhone 可正常鎖屏不影響定位模擬。

---

安裝後桌面/開始選單出現 **LocWarp** 捷徑。開啟時會要求管理員權限(WiFi tunnel 建 TUN 介面必需)。

---

## 專案結構

```
locwarp/
├── backend/                 # FastAPI + pymobiledevice3
│   ├── api/                 # HTTP endpoints
│   ├── core/                # Simulation engine + handlers
│   │   ├── simulation_engine.py
│   │   ├── navigator.py
│   │   ├── route_loop.py
│   │   ├── multi_stop.py
│   │   ├── random_walk.py
│   │   ├── joystick.py
│   │   └── device_manager.py
│   ├── services/            # Location service, interpolator, bookmarks
│   ├── models/schemas.py    # Pydantic models
│   ├── config.py            # Speed profiles, cooldown table
│   ├── main.py              # Entrypoint
│   └── locwarp-backend.spec # PyInstaller spec
│
├── frontend/                # Electron + React
│   ├── electron/main.js     # Electron entry, spawns backend in packaged mode
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/      # MapView, ControlPanel, EtaBar, etc.
│   │   ├── hooks/           # useSimulation, useDevice, useBookmarks
│   │   └── services/api.ts
│   ├── build/icon.ico       # App icon
│   └── package.json         # electron-builder config
│
├── wifi_tunnel.py           # Python 3.13 standalone tunnel helper
├── wifi-tunnel.spec         # PyInstaller spec
├── start.py                 # Dev launcher (used by LocWarp.bat)
├── stop.py
├── LocWarp.bat              # Dev entry (auto-elevates)
└── build-installer.bat      # Build installer (one-shot)
```

---

## 疑難排解

| 症狀 | 可能原因 / 解法 |
| --- | --- |
| Tunnel 啟動後 backend 連不上 | 確認以系統管理員身份啟動 |
| `No such service: com.apple.instruments.dtservicehub` (iOS 17+/26) | LocWarp 會自動嘗試掛載 Developer Disk Image;若仍失敗,請:(1) 設定 → 隱私權與安全性 → **開發者模式** 關閉,重開機,再次開啟;(2) 確認可連線至 github.com(DDI 由此下載,約 20MB);(3) 拔除重插裝置再試。v0.1.34 起會自動回退到 legacy `com.apple.dt.simulatelocation` 服務。 |
| DDI 下載卡住 / 逾時 | 檢查網路是否可到達 github.com;公司或校園網路可能封鎖 raw.githubusercontent.com。 |
| **開發者模式未顯示**(iOS 17+) | 需先讓裝置被任一自簽 IPA 部署過,設定中方會出現該選項。請見下方 [附錄:iPhone 開啟開發者模式(Windows 流程)](#附錄iphone-開啟開發者模式windows-流程)。 |

---

### 附錄:iPhone 開啟開發者模式(Windows 流程)

iOS 17+ 的「設定 → 隱私權與安全性 → 開發者模式」預設**不顯示**。Apple 要求裝置必須曾經被開發者簽署之 App 部署過,該選項才會出現。使用者可依下列流程側載任一自簽 IPA 完成觸發:

1. 安裝 [**Sideloadly**](https://sideloadly.io/)。
2. 於 [**Decrypt IPA Store**](https://decrypt.day/) 等解密 IPA 網站取得任意 IPA 檔案。建議挑選體積較小的檔案管理類 App 以縮短側載時間。
3. 將 IPA 拖入 Sideloadly 視窗。
4. USB 連接 iPhone,於 Sideloadly 輸入個人 Apple ID。
5. 按下 **Start** 執行側載,等待完成。
6. iPhone 上 設定 → 隱私權與安全性 → 滑至底部 → 會出現「**開發者模式**」。開啟該開關。
7. 系統提示重新啟動,重啟後再次確認開發者模式為開啟狀態。

完成後即可回到 LocWarp 建立連線。首次連線時,LocWarp 會視需要自動下載並掛載 Developer Disk Image。

> 本流程參考自社群使用者回饋,感謝分享。

---

## License

本專案採用 **MIT License** 授權釋出, 詳見 [LICENSE](LICENSE)。

允許自由使用、修改、再散佈與商業利用,惟須保留原始著作權與授權聲明。

---

## Disclaimer(免責聲明)

### 1. 僅限學術與研究用途

本專案開發初衷僅供地理資訊系統(GIS)研究、行動應用程式開發測試、位置服務原型驗證及相關技術探討使用。請勿將本工具用於任何非法用途,或違反第三方服務條款、平台政策之行為。

### 2. 帳號封禁風險

本專案透過 pymobiledevice3 介接 Apple DVT / RemoteServices 協議,以模擬 GPS 訊號達成虛擬定位。若將本工具用於基於地理位置的遊戲(例如 Pokémon GO、Ingress、Monster Hunter Now 等)或社交、打卡、物流類應用,可能違反該平台的服務條款,進而導致帳號遭警告、限制、封鎖或永久停權。**開發者對因使用本工具所造成之任何帳號損失、虛擬財產損害或衍生糾紛,概不負責。**

### 3. 系統與硬體風險

本專案於 WiFi Tunnel 模式下需以**系統管理員權限**執行,以建立 TUN 虛擬網路介面並與 iOS 裝置協商 RSD(Remote Service Discovery)通道。雖然程式碼已經內部測試,但開發者不保證於所有 Windows 版本、硬體組合、網路環境下皆能穩定運行。常見的潛在狀況包括:

- 與 VPN 軟體、第三方防火牆或網路虛擬化工具發生衝突,導致 Tunnel 建立失敗或系統網路暫時異常
- 程式非正常結束時殘留的 TUN 介面需重新啟動系統始能清除
- 連線中斷時需手動重試或重啟應用程式

使用者應自行評估上述風險並承擔因此所產生之任何後果。本專案僅操作本身所建立之臨時網路介面與自身設定檔(位於 `~/.locwarp/`),**不會修改 iOS 裝置內任何使用者資料,亦不會變更作業系統核心檔案或既有裝置配對記錄**。

### 4. 地圖資料準確性

本專案前端採用 Leaflet,底圖由 OpenStreetMap 之衍生供應商(CartoDB)提供,路線規劃與地理編碼則使用 OSRM 與 Nominatim 公共 API。地圖顯示之座標、路徑、地址資訊**僅供參考**,開發者不保證其完整性、即時性、正確性或與實際地理位置完全一致。使用者在依照地址搜尋、路線導航、隨機漫步等結果進行定位模擬前,應自行比對地圖顯示是否符合預期。

### 5. 使用者責任

使用者應自行遵守所在地之法律法規,包括但不限於《個人資料保護法》《電腦處理個人資料保護法》《著作權法》及相關國際條約。任何因濫用、誤用或違法使用本工具所引發之法律糾紛、民事賠償或刑事責任,均由使用者個人獨自承擔,與本專案之開發者及貢獻者無涉。

---

**下載、安裝或執行本軟體,即視為您已完整閱讀並同意上述全部免責條款。**

**若不同意,請立即停止使用並移除本軟體。**
