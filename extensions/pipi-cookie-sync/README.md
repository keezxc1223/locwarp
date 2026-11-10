# LocWarp 蘑菇地圖 Cookie 同步 (Chrome 擴充功能)

LocWarp 的「蘑菇地圖」圖層需要 pipimushroom.com 的登入 Cookie。這個擴充功能會把你在 Chrome 裡登入後的 Cookie 自動送到本機的 LocWarp，不用再開 F12 手動複製。

## 安裝

1. Chrome 網址列輸入 `chrome://extensions`
2. 右上角打開「開發人員模式」
3. 按「載入未封裝項目」，選這個資料夾 (`extensions/pipi-cookie-sync`)
4. 建議把它釘選到工具列 (拼圖圖示 → 圖釘)，方便看同步狀態

接著在 Chrome 登入 https://pipimushroom.com/ (已登入就不用)，再啟動 LocWarp，就會自動同步。

更新擴充功能的檔案後，要到 `chrome://extensions` 在這張卡片上按 ↻ 重新載入才會生效。

**有多個 Chrome 設定檔 (profile) 時**：擴充功能只看得到「它所在的那個設定檔」的登入狀態，請在工具列有這個擴充功能的視窗登入 pipimushroom.com。

## 怎麼讀 Cookie

擴充功能自己向 `https://pipimushroom.com/ApiSession.ashx` 發一次請求，擷取 Chrome 實際附上的 `Cookie` 標頭，內容就是手動從 F12 複製的那一行，然後原封不動送給 LocWarp。同一個回應也會告訴擴充功能這個設定檔有沒有登入。

不用 `chrome.cookies.getAll()` 組 Cookie 的原因：它會漏掉 Chrome 實際會送出的部分 Cookie。在 pipimushroom.com 上，漏掉的是非 Secure 的 Cookie，登入用的 session 正好在其中，結果送出的是舊的未登入 Cookie。`cookies` 權限現在只用來偵測 Cookie 有沒有變動。

登入大約 15 分鐘會到期，網站會在使用時自動延長。LocWarp 收到網站換新的 Cookie 時會自己更新並存檔；你在瀏覽器重新登入時，擴充功能也會再同步一次。

## 工具列圖示的狀態

| 標記 | 意思 |
|---|---|
| ✓ | 已同步，網站確認已登入 |
| ! | Chrome 沒有登入 pipimushroom.com (或登入已過期)，打開網站登入即可；或 LocWarp 驗證失敗 (訊息會說明) |
| ? | 網站暫時連不上、限流，或沒擷取到 Cookie，一分鐘後自動重試 |
| × | LocWarp 沒在執行，啟動後一分鐘內會自動同步 |
| … | 同步中 |

滑鼠移到圖示上可以看到詳細訊息，點一下圖示會立即重新同步。

## 什麼時候會同步

- 安裝或重新載入時、Chrome 啟動時、點工具列圖示時
- pipimushroom.com 的登入 Cookie 變動 (重新登入、session 換新) 後約 3 秒，最多每分鐘一次
- 每分鐘檢查一次：上次沒成功、LocWarp 回報沒有 Cookie，或 LocWarp 回報登入已過期時會重新同步
- 已同步時每 5 分鐘向網站確認一次登入狀態，讓 Chrome 這邊的登入不會因為閒置而過期

以下情況不會連到 pipimushroom.com：LocWarp 沒在執行、Chrome 沒有登入 (等你登入後才同步)。

## 權限與隱私

- `webRequest` + `https://pipimushroom.com/*`：只擷取擴充功能自己發給 pipimushroom.com 那個請求的 Cookie 標頭，不看其他網站或分頁的請求
- `cookies`：只用來偵測 pipimushroom.com 的 Cookie 有沒有變動
- `http://127.0.0.1:8777/*`：Cookie 只送到本機的 LocWarp，不會送到其他地方
- `storage`：只存 Cookie 的 SHA-256 雜湊值和同步狀態，用來判斷有沒有變，不存 Cookie 本身
- `alarms`：每分鐘檢查一次

## 移除

`chrome://extensions` 找到「LocWarp 蘑菇地圖 Cookie 同步」按「移除」。LocWarp 裡已存的 Cookie 可以在蘑菇地圖面板按「清除」。

## 開發

- 設計說明和 v1.0 漏讀 Cookie 的調查紀錄：[`docs/pipi-mushroom.md`](../../docs/pipi-mushroom.md)
- 測試 (不連網站、不碰 LocWarp)：在 repo 根目錄執行 `node tests/pipi/test_extension.js`
- 修改後記得調高 `manifest.json` 的 `version`，再到 `chrome://extensions` 按 ↻
