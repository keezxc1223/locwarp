# 上架 Chrome 線上應用程式商店:要填的內容

擴充功能原始碼在 `extensions/pipi-cookie-sync/`。上傳用的 zip 用下面的指令產生(輸出到 `dist-ext/`,不進版控):

```bash
py -3.13 extensions/pack.py
```

上架後,把商店網址填進 `frontend/src/components/PipiMushroomPanel.tsx` 的 `EXTENSION_STORE_URL`,登入教學的第一步就會變成「從商店安裝」,不再需要載入未封裝項目。

## 商店資訊

| 欄位 | 內容 |
| --- | --- |
| 名稱 | LocWarp 蘑菇地圖 Cookie 同步 |
| 簡短說明 | 把 pipimushroom.com 的登入狀態同步到本機的 LocWarp,供蘑菇地圖圖層使用。 |
| 類別 | 工具 |
| 語言 | 中文(繁體) |
| 隱私權政策網址 | https://github.com/keezxc1223/locwarp/blob/main/docs/pipi-extension-privacy.md |
| 首頁網址 | https://github.com/keezxc1223/locwarp |

### 詳細說明

```
這個擴充功能是 LocWarp(Windows 上的 iOS 虛擬定位工具)的輔助工具。

LocWarp 的「蘑菇地圖」圖層會顯示 pipimushroom.com 上玩家回報的蘑菇、花與煙霧點位。這個網站需要登入才提供資料,所以 LocWarp 需要你在瀏覽器登入後的登入狀態。

安裝這個擴充功能後:
1. 在 Chrome 登入 pipimushroom.com。
2. 開啟 LocWarp。
3. 登入狀態會自動同步到本機的 LocWarp,蘑菇地圖就能載入點位。

隱私:
- 只讀取 pipimushroom.com 的登入 Cookie,不讀取其他網站的資料。
- Cookie 只會送到你自己電腦上的 LocWarp (127.0.0.1:8777),不會送到任何遠端伺服器。
- 不接觸你的 Google 帳號密碼。
- 沒有廣告、分析或追蹤。

工具列圖示會顯示同步狀態,點一下可以立即重新同步。

需要先安裝 LocWarp:https://github.com/keezxc1223/locwarp
原始碼:https://github.com/keezxc1223/locwarp/tree/main/extensions/pipi-cookie-sync
```

## 隱私權實務(Privacy practices 分頁)

**單一用途說明**

```
把使用者在 pipimushroom.com 的登入狀態同步到同一台電腦上執行的 LocWarp 應用程式,讓 LocWarp 的蘑菇地圖圖層可以載入該網站的點位資料。
```

**各項權限的理由**

| 權限 | 理由 |
| --- | --- |
| `cookies` | 偵測 pipimushroom.com 的登入 Cookie 是否變動(重新登入或 session 換新),以決定是否需要重新同步。只用於這個網域。 |
| `webRequest` | 讀取擴充功能自己發給 pipimushroom.com 的那一個請求的 Cookie 標頭。`chrome.cookies.getAll()` 會漏掉瀏覽器實際送出的部分 Cookie,所以必須從實際請求讀取。不觀察其他網站或分頁的請求。 |
| `storage` | 儲存 Cookie 的 SHA-256 雜湊值與同步狀態,用來判斷登入狀態有沒有變動。不儲存 Cookie 本身。 |
| `alarms` | 每分鐘檢查一次是否需要重新同步(上次失敗,或 LocWarp 回報沒有登入資料時)。 |
| 主機權限 `https://pipimushroom.com/*` | 向該網站發出一次請求以取得登入狀態,並偵測該網域的 Cookie 變動。 |
| 主機權限 `http://127.0.0.1:8777/*` | 把登入狀態送給本機執行的 LocWarp。這是使用者自己的電腦,不是遠端伺服器。 |

**遠端程式碼**:沒有使用。所有程式碼都在套件內。

**資料使用揭露**

- 會收集的資料類型:勾選「驗證資訊 (Authentication information)」。
- 三項聲明全部勾選:不販售或轉移給第三方、不用於與單一用途無關的目的、不用於信用評估或放款。
- 說明時可以補一句:資料只在使用者自己的電腦上,由擴充功能交給本機的 LocWarp。

## 上傳前檢查

- `manifest.json` 的 `version` 每次上傳都要比商店上的版本高。
- 商店需要至少一張 1280x800 或 640x400 的螢幕截圖,可以用 LocWarp 蘑菇地圖面板的畫面。
- 圖示在 `extensions/pipi-cookie-sync/icons/`(16、32、48、128),由 `frontend/build/icon.png` 產生。

## 審核風險

這個擴充功能會讀取某個網站的登入 Cookie 並送出瀏覽器,審核時可能被要求補充說明。上面的單一用途、權限理由與隱私權政策已經把「只處理一個網域、只送到本機」寫清楚;若被退件,通常依退件信指出的項目補充說明後可以重送。
