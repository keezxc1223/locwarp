# LocWarp

**在 Windows 上控制 iPhone / iPad GPS 定位的虛擬定位工具。** 免越獄,透過 USB 或 WiFi 連線,支援瞬移、導航、多點路徑、花農繞圈、隨機漫步與搖桿操作,最多可同時控制三台裝置。

<p align="right">
  <a href="README.md"><img alt="繁體中文" src="https://img.shields.io/badge/繁體中文-active-2d3748?style=flat-square"></a>
  <a href="README.en.md"><img alt="English" src="https://img.shields.io/badge/English-gray?style=flat-square"></a>
</p>

<p align="center">
  <img src="frontend/build/icon.png" width="128" alt="LocWarp">
</p>

<p align="center">
  <a href="https://github.com/keezxc1223/locwarp/releases">
    <img alt="下載安裝檔" src="https://img.shields.io/badge/下載安裝檔-4285f4?style=for-the-badge&logo=github&logoColor=white">
  </a>
  <a href="#安裝與前置設定">
    <img alt="安裝說明" src="https://img.shields.io/badge/安裝說明-2d3748?style=for-the-badge&logo=readthedocs&logoColor=white">
  </a>
  <a href="https://lin.ee/UwdCrmf" target="_blank">
    <img alt="LINE" src="https://img.shields.io/badge/LINE-聯絡作者-06C755?style=for-the-badge&logo=line&logoColor=white">
  </a>
</p>

<p align="center">
  <img src="docs/demo-v2.gif" width="720" alt="LocWarp demo">
</p>

## 目錄

- [快速開始](#快速開始)
- [系統需求與相容性](#系統需求與相容性)
- [功能](#功能)
- [安裝與前置設定](#安裝與前置設定)
- [疑難排解](#疑難排解)
- [開發者文件](#開發者文件)
- [支持與聯絡](#支持與聯絡)
- [專案性質聲明](#專案性質聲明)
- [License](#license)
- [Disclaimer(免責聲明)](#disclaimer免責聲明)

---

## 快速開始

1. 到 [Releases](https://github.com/keezxc1223/locwarp/releases) 下載最新的 `LocWarp Setup x.y.z.exe` 並安裝。
2. 電腦安裝 iTunes 或 Apple Devices(提供 Apple USB driver)。
3. 用 USB 線接上 iPhone,在 iPhone 上點「信任這部電腦」。
4. iPhone 開啟「設定 → 隱私權與安全性 → 開發者模式」。找不到這個選項時,LocWarp 連線後到「設定」頁按「開啟開發者模式」就會出現。
5. 開啟 LocWarp(會要求系統管理員權限),在地圖上按右鍵即可瞬移。

每個步驟的細節見[安裝與前置設定](#安裝與前置設定)。防毒軟體若把後端程式誤判隔離,請先把安裝資料夾加入排除清單再重新安裝。

---

## 系統需求與相容性

| 項目 | 需求 |
| --- | --- |
| 電腦 | Windows 10 / 11(64 位元) |
| 裝置 | iPhone / iPad,**iOS / iPadOS 17 以上**為主要支援版本 |
| iOS 16.x | 由社群維護(@bitifyChen,[#9](https://github.com/keezxc1223/locwarp/pull/9)),走 LegacyLocationService 路徑 |
| iOS 15 以下 | 不支援 |
| 連線 | USB 線,或同一個 WiFi 網段(WiFi Tunnel 僅 iOS 17+) |

### 已回報可用的版本

| 主版本 | 已驗證版本 |
| --- | --- |
| **iOS 27.x** | 27.0(開發者實測,iPhone 18 Pro Max) |
| **iOS 26.x** | 26.5 · 26.4.2 · 26.4.1 · 26.4.1 iPadOS · 26.4 · 26.3.1 · 26.2 · 26.2.1 iPadOS (M1 iPad) |
| **iOS 18.x** | 18.7.8 · 18.7.7 · 18.7.1 · 18.6.2 · 18.5 iPadOS · 18.3.1 · 18.1.1 |
| **iOS 17.x** | 17.6.1 |
| **iOS 16.x**(社群維護) | 16.7.15 · 16.7.12 |

「回報可用」代表**至少一位使用者在其環境下成功運作**,不等同於通用相容性保證。虛擬定位的穩定性取決於 iOS 修補版本、pymobiledevice3 對該版本的支援、Developer Disk Image 是否已掛載,以及 Windows 端的驅動、VPN、防火牆與防毒設定。沒列在表上的 iOS 16+ 版本只是還沒有人回報,歡迎到 [Issues](https://github.com/keezxc1223/locwarp/issues) 補充。

---

## 功能

### 移動模式

| 模式 | 說明 |
| --- | --- |
| **瞬移** | 直接跳到指定座標 |
| **導航** | 從目前位置沿實際道路以走路、腳踏車或開車的速度前往目的地 |
| **多點路徑** | 依序經過多個路徑點,每站可停留(預設隨機 5 到 20 秒)。圈數設 0 為跑一趟,設 N 為繞 N 圈,留空為無限循環 |
| **花農專用** | 在每個路徑點周圍繞圈。繞圈距離、每圈段數(3 到 20)、每點圈數(0.5 為半圈)、總輪數、每點前後等待都可以自訂並保存,點與點之間可走過去或瞬移。面板會即時顯示整趟預估時間,斷線會自動重連續跑 |
| **隨機漫步** | 在指定半徑內隨機漫遊,每段停頓時間可調 |
| **搖桿** | 以方向和力度即時操控,支援 WASD 與方向鍵 |

多點路徑可以勾選「**點對點跳躍**」,改成逐點瞬移而不走道路,適合只需要 GPS 依序停在每個點上的情況。跳躍前延遲(預設 2 秒)與跳躍後延遲(預設 4 秒)都可以調整,暫停時兩段延遲都會凍結。

### 速度控制

- 三檔預設:走路 10.8、腳踏車 19.8、開車 60 km/h。
- 可輸入任意固定速度,或輸入最小到最大的隨機範圍(例如 40 到 80 km/h),每段路重新抽一次,模擬真實路況。
- 移動進行中可以修改速度後按「套用新速度」,會從目前位置以新速度接續,不用停下重來。
- 選過的速度會記住,下次開啟沿用。到點暫停時地圖上方會顯示倒數。

### 路徑來源

導航與多點路徑使用的道路路線,可以在四個免費、免註冊的路徑引擎之間切換:

| 引擎 | 說明 |
| --- | --- |
| **OSRM 公用 demo**(預設) | 全球涵蓋,偶爾整個服務會中斷 |
| **OSRM FOSSGIS** | 同樣是 OSRM 引擎,由 FOSSGIS 代管的鏡像 |
| **Valhalla** | 完全不同的引擎,兩個 OSRM 節點都中斷時最有用 |
| **BRouter** | 獨立營運的第四個引擎,單車、健行、開車 profile 齊全 |

任何引擎失敗時,該段路自動改走直線,下一段再重試,不會卡住。也可以直接勾選「使用直線路徑」完全不查詢引擎。多點路徑另有「最佳順序」功能,一鍵算出最短的走訪順序。

### 連線方式

- **USB**:插上自動連線,iPhone 鎖定螢幕不受影響。拔除約 4 秒內偵測到,重新插上自動恢復,不用重新整理。
- **WiFi Tunnel**(iOS 17+,需先用 USB 配對過一次):
  - 「自動偵測」會先用 mDNS 尋找裝置,找不到再掃描區域網路。
  - 連過的 IP 會記住,也可以「釘選」裝置,之後每次啟動自動連上,斷線自動重試。
  - 「螢幕暗掉維持連線」(實驗功能)會持續補送位置,降低 iPhone 鎖定螢幕後斷線的機率。
  - 「重新配對」可在配對記錄損毀時,透過 USB 一鍵重建。
  - 停止 Tunnel 時若 USB 還插著,會自動切回 USB。

### 多裝置群組模式

可同時連接**最多三台**裝置。瞬移、導航、各種移動模式、暫停、繼續、停止、套用速度、還原,都會同步送到所有裝置,桌面與手機網頁操控都適用。

- 啟動任何動作前,會先把所有裝置瞬移到同一個座標,確保路徑一致。
- 隨機漫步使用相同的亂數種子,所有裝置走的路線完全相同。
- 後來才接上的裝置,會自動同步到目前位置並接續正在執行的任務。
- 每台裝置可以個別還原、中斷或開啟開發者模式選項。

### 地圖

- **圖層切換**(右上角):OSM、Google 圖磚(測試)、ESRI 街道、ESRI 衛星、OpenFreeMap Liberty / Bright / Positron(向量圖)、VersaTiles Colorful、NLSC 台灣電子地圖、GSI 日本地理院地圖。全部免 API key。
- 路徑點以 S / 1 / 2 / 3 標示,路徑線有流動箭頭可以看出方向。
- 左上角按鈕可一鍵置中目前的模擬位置。選「只顯示路徑」時地圖會自動縮放到整條路線。
- 地圖上的使用者圖示可以換成內建的 6 組角色,或上傳自己的 PNG(自動去除透明邊界)。
- 座標格式可在 DD、DMS、DM 之間切換。

### 座標收藏

- 新增座標時自動帶入地名與國旗,編輯後座標改變會自動更新國旗。
- 分類可自訂顏色,支援搜尋、排序(名稱 / 日期 / 最後使用)、拖曳排序、多選刪除。
- 匯入與匯出:JSON(全部資料,匯入為合併不覆蓋)、GPX(單筆、整個分類,或多個分類一次匯出成 ZIP)。
- 可把所有收藏顯示在地圖上,數萬筆也不會卡頓,密集的點會自動聚合。
- 「點擊也要飛 GPS」可以決定點座標時是真的瞬移過去,還是只把地圖畫面移過去看看。

### 儲存路線

- 路線可以分類、拖曳排序,並從清單直接載入開始跑。
- 支援 GPX 與 JSON 的匯入匯出。
- 可以把路徑點依目前順序複製成一行一筆的 `lat, lng` 文字。

### 地址搜尋

- **免費版**:預設來源,使用 OpenStreetMap 開放資料,不用 API key。設定裡另有 Photon 選項,模糊搜尋與錯字容錯較強。
- **Google Geocoding**:輸入自己的 API key(只存在本機),中文地名與店家結果最精準,每月有免費額度。
- 座標輸入框可以直接貼上座標文字,會自動辨識出有效的經緯度。
- 手機網頁操控會沿用電腦端的設定。

### 手機網頁操控

人不在電腦旁時,可以用手機瀏覽器操控。按狀態列的「手機操控」會顯示區域網路網址與 6 位數 PIN,手機輸入後就能使用行動版地圖:瞬移、導航到指定點(走路 / 腳踏車 / 開車或自訂速度)、搜尋地址、輸入座標、停止與還原,並即時顯示桌面上同一條路徑。

> 手機必須跟電腦連在**同一個 WiFi**,電腦防火牆需放行 8777 port。按「重新產生」可立刻更換 PIN,讓之前配對過的手機失效。

### 狀態列資訊

- 目前模擬位置的**國旗、地名、當地天氣與溫度**。
- 跨時區時顯示時差,點開可看完整時區資訊。
- **一鍵還原**:清除虛擬定位。注意「停止」只會結束移動,虛擬定位仍然保留,要恢復真實 GPS 請按還原。
- 版本號:有新版本時旁邊出現 `NEW` 標示,點擊前往下載頁。
- 「Log 資料夾」按鈕:一鍵開啟 `~/.locwarp/logs/`,方便把 backend.log 附到 Issue。

### 其他

- **Cooldown**:依瞬移距離自動計算冷卻時間,降低被偵測為異常移動的風險。
- 介面語言可在繁體中文與 English 之間即時切換。
- 路線完成提示音、硬體加速開關(部分顯示卡驅動下關閉可解決殘影或黑畫面,見 [Issue #24](https://github.com/keezxc1223/locwarp/issues/24))。
- 所有資料(座標收藏、路線、設定)都存在 `~/.locwarp/`,重新安裝不會遺失。

---

## 安裝與前置設定

**[下載安裝檔](https://github.com/keezxc1223/locwarp/releases)**。安裝檔已包含所有需要的元件,不用另外安裝 Python 或 Node。安裝後從桌面或開始選單開啟 **LocWarp**,啟動時會要求系統管理員權限(WiFi Tunnel 建立虛擬網路介面需要)。

### 1. 安裝 Apple USB driver

Windows 需要 Apple 的 USB driver 才能跟 iPhone 溝通。下列**擇一**安裝即可:

- [iTunes for Windows(桌面版,64-bit)](https://secure-appldnld.apple.com/itunes12/047-76416-20260302-fefe4356-211d-4da1-8bc4-058eb36ea803/iTunes64Setup.exe)
- [Microsoft Store 的 iTunes](https://apps.microsoft.com/detail/9pb2mz1zmb1s)
- [Microsoft Store 的 Apple Devices](https://apps.microsoft.com/detail/9np83lwlpz9k?hl=zh-TW&gl=TW)

多數人裝桌面版 iTunes 就能用。如果 iTunes 抓不到 iPhone,社群回報改裝 Apple Devices 可以成功。

### 2. USB 連接並信任此電腦

第一次使用前用 USB 線接上 iPhone,iPhone 會詢問「要信任這部電腦嗎?」,點**信任**並輸入密碼。

### 3. 開啟開發者模式

iPhone 上:**設定 → 隱私權與安全性 → 開發者模式 → 開啟**,裝置會要求重新啟動,重啟後再確認一次。

iOS 16 以上預設不顯示這個選項。LocWarp 連上裝置後,到上方的「**設定**」頁按「**開啟開發者模式**」按鈕,按下後:

1. 在 iPhone 上完全關掉「設定」App。
2. 重新打開「設定 → 隱私權與安全性」,往下拉就會看到「開發者模式」。
3. 開啟它,依指示重新啟動。

按鈕不能用的時候(例如只有 WiFi 連線),可以改用[側載 IPA 的備援方式](#附錄用側載方式讓開發者模式出現)。

### 4. 掛載 Developer Disk Image(iOS 17+)

iOS 17 以上需要 iPhone 上掛有 Personalized DDI 才能模擬定位。LocWarp 只會檢查,不會自動下載或掛載。如果提示「iPhone 上未偵測到 DDI」,請用下列任一工具幫 iPhone 掛一次:Xcode、愛思助手、3uTools、pymobiledevice3 CLI。

### 5. WiFi Tunnel(選用)

想拔掉 USB 改用無線時:

- iPhone 與電腦必須在**同一個 WiFi 網段**。
- 必須先完成步驟 2 的 USB 配對。
- 在 LocWarp 的「連線」頁啟動 WiFi Tunnel,成功後即可拔除 USB。

| 連線方式 | iPhone 鎖定螢幕 | 建議 |
| --- | --- | --- |
| **USB** | 不受影響 | 無 |
| **WiFi Tunnel** | 會讓網路介面休眠,連線中斷 | 關閉自動鎖定,或開啟「螢幕暗掉維持連線」 |

使用 WiFi Tunnel 時建議把「設定 → 顯示與亮度 → 自動鎖定」設為**永不**,並接上充電線。

---

## 疑難排解

| 症狀 | 可能原因與解法 |
| --- | --- |
| 開啟後顯示後端程式不存在 | 防毒軟體把未簽章的後端 exe 隔離了。把安裝資料夾加入排除清單後重新安裝 |
| Tunnel 啟動後連不上 | 確認以系統管理員身分啟動;暫時關閉 VPN 或第三方防火牆再試 |
| WiFi 自動偵測找不到裝置 | 確認在同一個 WiFi 網段、路由器沒有開啟裝置隔離(AP isolation);可改為手動輸入 IP |
| `No such service: com.apple.instruments.dtservicehub`,或提示「未偵測到 DDI」 | 依[步驟 4](#4-掛載-developer-disk-imageios-17)掛載 DDI。仍失敗時,先把開發者模式關閉、重開機、再次開啟,然後重新掛載 |
| iPhone 設定裡找不到開發者模式 | LocWarp 連上裝置後,到上方的「設定」頁按「開啟開發者模式」,再依[步驟 3](#3-開啟開發者模式)關掉並重開 iPhone 的「設定」App。按鈕無效時改用[側載方式](#附錄用側載方式讓開發者模式出現) |
| 畫面殘影或黑畫面 | 在「設定」頁關閉硬體加速 |
| 打開程式直接閃退 | 新版會自動改為軟體渲染並重啟;仍閃退的話,對捷徑按右鍵 › 內容 › 目標,結尾補上 `--no-sandbox --disable-gpu --in-process-gpu` |
| 國旗或地名沒有出現 | 這兩項來自免費的公共服務,偶爾會暫時無回應,稍後再瞬移一次即可 |

回報問題時請附上 iOS 版本、連線方式,以及 `~/.locwarp/logs/backend.log`。

### 附錄:用側載方式讓開發者模式出現

1. 安裝 [Sideloadly](https://sideloadly.io/)。
2. 從 [Decrypt IPA Store](https://decrypt.day/) 或 [ARM Converter Decrypted App Store](https://armconverter.com/decryptedappstore/us) 取得任意一個 IPA,建議挑體積小的。
3. 把 IPA 拖進 Sideloadly,USB 接上 iPhone,輸入個人 Apple ID 後按 **Start**。
4. 完成後,iPhone 的「設定 → 隱私權與安全性」最下方會出現「開發者模式」,開啟並重新啟動。

---

## 開發者文件

### 架構

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

### 技術組成

| 層 | 技術 | 用途 |
| --- | --- | --- |
| Frontend | [Electron](https://www.electronjs.org/) 44 | 桌面外殼,負責視窗、啟動 backend、改寫圖磚請求的 User-Agent |
| Frontend | [React](https://react.dev/) 19 + [TypeScript](https://www.typescriptlang.org/) 7 + [Vite](https://vitejs.dev/) 8 | UI 與打包(`base: './'` 供 `file://` 載入) |
| Frontend | [Leaflet](https://leafletjs.com/) 1.9 | 互動地圖、自訂標記、動畫路徑線 |
| Frontend | [MapLibre GL](https://maplibre.org/) 6 | 向量圖層渲染,經 maplibre-gl-leaflet 掛進 Leaflet |
| Backend | Python 3.13 + [FastAPI](https://fastapi.tiangolo.com/) + [uvicorn](https://www.uvicorn.org/) | REST API 與 WebSocket(`:8777`) |
| Backend | [pymobiledevice3](https://github.com/doronz88/pymobiledevice3) 11.49+ | iOS 裝置協議(DVT / RemoteServices / lockdown / LegacyLocationService)與 WiFi tunnel |
| Backend | [httpx](https://www.python-httpx.org/)、[pydantic](https://docs.pydantic.dev/)、[gpxpy](https://github.com/tkrajina/gpxpy) | 外部服務呼叫、資料驗證、GPX 解析 |
| 打包 | [PyInstaller](https://pyinstaller.org/)、[electron-builder](https://www.electron.build/)(NSIS) | backend exe 與 Windows 安裝檔 |

介面圖示全部是 inline SVG,樣式是手寫的單一 `styles.css`,沒有使用第三方 icon 或 UI 套件。

### 外部服務

全部免費。除了 Google Geocoding 需要使用者自備 key,其餘都不需要註冊。

| 服務 | 呼叫端 | 用途 |
| --- | --- | --- |
| [OSRM demo](https://project-osrm.org/)、[OSRM FOSSGIS](https://routing.openstreetmap.de/)、[Valhalla](https://valhalla1.openstreetmap.de/)、[BRouter](https://brouter.de/) | backend | 路線規劃與多點順序最佳化 |
| [Photon (komoot)](https://photon.komoot.io/) | backend | 地址搜尋與反向地理編碼(國旗、地名) |
| [Google Geocoding API](https://developers.google.com/maps/documentation/geocoding) | backend | 地址搜尋(選用,使用者自備 key) |
| [Open-Meteo](https://open-meteo.com/) | frontend | 模擬位置的天氣 |
| [TimezoneDB](https://timezonedb.com/) | backend | 座標轉時區(內建 key) |
| [flagcdn.com](https://flagcdn.com/) | frontend | 國旗圖片 |
| OpenStreetMap、Google、[ESRI](https://www.esri.com/)、[OpenFreeMap](https://openfreemap.org/)、[VersaTiles](https://versatiles.org/)、[NLSC](https://maps.nlsc.gov.tw/)、[GSI](https://www.gsi.go.jp/) | frontend | 地圖圖磚 |
| [GitHub Releases](https://github.com/keezxc1223/locwarp/releases) | frontend | 啟動時檢查新版本(無遙測) |

反向地理編碼不使用 Nominatim 公共伺服器,因為它的使用政策以應用程式為單位計算流量上限,不適合散佈型的桌面程式。地址搜尋的預設選項若被 Nominatim 拒絕,會自動改用 Photon。

### 核心模組(`backend/core/`)

| 模組 | 職責 |
| --- | --- |
| `simulation_engine.py` | 中央控制器:狀態轉換、任務生命週期、`_move_along_route()` 移動迴圈、ETA 計算 |
| `device_manager.py` | 裝置探索、USB 與 WiFi Tunnel 連線管理 |
| `navigator.py` | 單一目的地導航 |
| `route_loop.py` / `multi_stop.py` | 多點路徑的循環與停留 |
| `flower.py` | 花農專用的繞圈邏輯 |
| `random_walk.py` / `joystick.py` | 隨機漫步、搖桿 |
| `teleport.py` / `restore.py` | 瞬移、還原 |

### 設計重點

- **位置推播**:backend 每個 tick 透過 WebSocket 送出 `position_update`,前端即時更新地圖與 ETA。
- **速度解析**:`config.resolve_speed_profile()` 統一處理模式預設、固定速度、隨機範圍,優先序為範圍 > 固定 > 預設。
- **In-process WiFi tunnel**:backend 直接在主 event loop 內執行 `start_tcp_tunnel()`,沒有獨立的 helper 程式。
- **狀態目錄**:所有執行期資料寫入 `~/.locwarp/`,避開 PyInstaller 的臨時目錄。
- **節制的地理查詢**:國旗、地名、時區、天氣只在靜止或瞬移後、且位置變動超過 100 公尺時查詢,移動中不查,避免干擾與裝置的通訊。四項查詢並行,其中一項慢不會拖住其他項。
- **反向地理編碼快取**:結果以約 100 公尺的格子為單位存在磁碟(`reverse_geocode_cache.json`,保留 30 天),回到查過的地方不再連網,同時發出的相同查詢會合併成一次。新增座標與「這裡是哪裡」會略過快取以取得精確名稱。
- **天氣由前端直連**:每個使用者用自己的 IP 計算 Open-Meteo 配額,不經 backend 轉送。
- **圖層預先連線**:滑鼠移到圖層選單時,預先對所有圖層的主機建立連線並抓取向量圖層的 style,縮短第一次切換的等待。
- **多裝置群組**:primary 裝置不會被後插的裝置取代,後插的裝置會同步到 primary 的位置並接續任務。

### 開發環境

需求:Windows 10 / 11、Python **3.13**、Node.js 18+,以及一台已配對並開啟開發者模式的 iPhone。

```bash
# 後端依賴(含 WiFi tunnel)
py -3.13 -m pip install -r backend/requirements.txt

# 前端依賴
cd frontend
npm install
```

雙擊 `LocWarp.bat` 會自動提權並啟動 backend(`:8777`)與 Vite dev server(`:5173`),並用預設瀏覽器開啟。也可以手動啟動:

```bash
# 終端 1:backend
cd backend && py -3.13 main.py

# 終端 2a:前端走瀏覽器
cd frontend && npx vite --host --port 5173

# 終端 2b:前端走 Electron 視窗(跟安裝檔相同的執行方式)
cd frontend && npm run start
```

> 開發模式走 `http://`,安裝檔走 `file://`,兩者行為不完全相同(例如 MapLibre 的 worker)。升級前端相依套件後,請務必用打包後的安裝檔驗證。

### 打包

```bash
# 一次性安裝
py -3.13 -m pip install pyinstaller
cd frontend && npm install -D electron-builder

# 一鍵建置
build-installer.bat
```

`build-installer.bat` 依序執行:

1. **PyInstaller** 編譯 backend 到 `dist-py/locwarp-backend/`
2. **Vite** 建置前端到 `frontend/dist/`
3. **electron-builder** 產出 `frontend/release/LocWarp Setup X.Y.Z.exe`(約 175 MB)

注意 `npm run dist` 只執行第 3 步。改過 backend 要重跑 PyInstaller,改過前端或版本號要重跑 `npx vite build`,否則安裝檔會帶到舊的內容。

### 專案結構

```
locwarp/
├── backend/                 # FastAPI + pymobiledevice3
│   ├── api/                 # HTTP endpoints
│   ├── core/                # Simulation engine + 各移動模式
│   ├── services/            # 定位服務、地理編碼、座標收藏、路線
│   ├── models/schemas.py    # Pydantic models
│   ├── static/phone.html    # 手機網頁操控頁面
│   ├── config.py            # 速度 profile、cooldown 表、路徑設定
│   ├── main.py              # Entrypoint
│   └── locwarp-backend.spec # PyInstaller spec
│
├── frontend/                # Electron + React
│   ├── electron/main.js     # Electron 進入點,打包模式下啟動 backend
│   ├── src/
│   │   ├── App.tsx
│   │   ├── components/      # MapView, ControlPanel, BookmarkList, StatusBar...
│   │   ├── hooks/           # useSimulation, useDevice, useBookmarks
│   │   ├── i18n/            # 中英文字串
│   │   └── services/api.ts
│   ├── build/               # 圖示與安裝程式圖片
│   └── package.json         # electron-builder 設定
│
├── LocWarp.bat / start.py   # 開發用啟動器(自動提權)
├── stop.py
└── build-installer.bat      # 一鍵建置安裝檔
```

---

## 支持與聯絡

有問題、建議,或想回報某個 iOS 版本可用,歡迎[加 LINE](https://lin.ee/UwdCrmf) 或到 [Issues](https://github.com/keezxc1223/locwarp/issues) 留言。

### USDT 斗內(TRC-20 / TRON 鏈)

LocWarp 免費且開源。想支持開發的話,可以使用下方地址。**僅支援 TRC-20(TRON 鏈)**,請勿使用其他鏈轉帳。

```
TB1i7pEcifAeh8oDLLZFqiRVrpUaZmmDAn
```

<p>
  <img src="docs/donate-usdt-tron-qr.png" alt="USDT TRC-20 QR" width="260">
</p>

---

## 專案性質聲明

LocWarp 是個人獨立維護的開源專案,不是商業產品,也沒有專職團隊。開發者會盡力在合理時間內新增功能、回應 Issue、修復 Bug,並隨 iOS 與 pymobiledevice3 的版本演進持續更新,但是:

- 本專案只保證在**開發者本人的測試環境**(目前為 iPhone 18 Pro Max / iOS 27.0 + Windows 11 專業版)下運作正常;
- **不保證在其他裝置、iOS 修補版本、網路環境、系統配置下都能穩定使用**;
- 遇到問題時,歡迎到 [Issues](https://github.com/keezxc1223/locwarp/issues) 提交完整的環境資訊與日誌,協助定位與改善;
- 本專案不保證永續維護,也不承擔因使用本工具所生的任何責任。

---

## License

本專案採用 **MIT License** 授權釋出,詳見 [LICENSE](LICENSE)。

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

本專案前端採用 Leaflet,底圖由 OpenStreetMap 及其他第三方圖磚供應商提供,路線規劃使用 OSRM、Valhalla 與 BRouter 公共服務,地理編碼使用 Photon 等公共服務。地圖顯示之座標、路徑、地址資訊**僅供參考**,開發者不保證其完整性、即時性、正確性或與實際地理位置完全一致。使用者在依照地址搜尋、路線導航、隨機漫步等結果進行定位模擬前,應自行比對地圖顯示是否符合預期。

### 5. 使用者責任

使用者應自行遵守所在地之法律法規,包括但不限於《個人資料保護法》《著作權法》及相關國際條約。任何因濫用、誤用或違法使用本工具所引發之法律糾紛、民事賠償或刑事責任,均由使用者個人獨自承擔,與本專案之開發者及貢獻者無涉。

---

**下載、安裝或執行本軟體,即視為您已完整閱讀並同意上述全部免責條款。**

**若不同意,請立即停止使用並移除本軟體。**
