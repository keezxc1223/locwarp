# LocWarp 蘑菇地圖 Cookie 同步:隱私權政策

最後更新:2026-11-11

這個 Chrome 擴充功能只做一件事:把你在 Chrome 登入 pipimushroom.com 之後的登入狀態,交給**同一台電腦上**執行的 LocWarp,讓 LocWarp 的蘑菇地圖圖層可以載入點位資料。

## 處理的資料

- **pipimushroom.com 的 Cookie(登入狀態)**:擴充功能會向 `https://pipimushroom.com/ApiSession.ashx` 發出一次請求,讀取 Chrome 為這個請求附上的 `Cookie` 標頭。
- 不讀取其他網站的 Cookie、瀏覽紀錄、分頁內容或任何表單資料。
- 不接觸你的 Google 帳號密碼。登入是你自己在 pipimushroom.com 完成的。

## 資料送到哪裡

- 上述 Cookie 只會送到 `http://127.0.0.1:8777`,也就是你這台電腦上執行的 LocWarp。
- 不會送到任何遠端伺服器,沒有開發者自己的伺服器,也沒有第三方。
- LocWarp 收到後把它存在本機的 `~/.locwarp/settings.json`,只用來向 pipimushroom.com 取得蘑菇地圖的點位資料。

## 擴充功能自己儲存的內容

- 只在 `chrome.storage` 存 Cookie 的 SHA-256 雜湊值與同步狀態,用來判斷登入狀態有沒有變動。
- 不儲存 Cookie 本身。

## 不做的事

- 不販售、不分享、不轉移任何使用者資料。
- 不用於廣告、分析或使用者追蹤。
- 沒有遙測,也不回報使用情況。

## 如何移除資料

- 在 `chrome://extensions` 移除這個擴充功能,它儲存的雜湊值與狀態會一併刪除。
- 在 LocWarp 的蘑菇地圖面板按「登入教學」裡的「清除登入資料」,可刪除 LocWarp 存下的 Cookie。

## 聯絡

問題與回報請到 <https://github.com/keezxc1223/locwarp/issues>。

---

# LocWarp Mushroom Map Cookie Sync: Privacy Policy

Last updated: 2026-11-11

This Chrome extension does one thing: after you log in to pipimushroom.com in Chrome, it hands that login state to LocWarp running **on the same computer**, so LocWarp's mushroom map layer can load spot data.

## Data handled

- **The pipimushroom.com cookies (login state)**: the extension makes one request to `https://pipimushroom.com/ApiSession.ashx` and reads the `Cookie` header Chrome attaches to that request.
- It does not read cookies of any other site, browsing history, tab contents or form data.
- It never sees your Google password. You sign in on pipimushroom.com yourself.

## Where the data goes

- The cookies are sent only to `http://127.0.0.1:8777`, which is LocWarp running on your own computer.
- Nothing is sent to any remote server. There is no developer server and no third party.
- LocWarp stores them locally in `~/.locwarp/settings.json` and uses them only to request mushroom map spot data from pipimushroom.com.

## What the extension itself stores

- Only a SHA-256 hash of the cookies and the sync status, in `chrome.storage`, to tell whether the login changed.
- Not the cookies themselves.

## What it does not do

- It does not sell, share or transfer any user data.
- It is not used for advertising, analytics or tracking.
- It has no telemetry and reports nothing about usage.

## Removing the data

- Removing the extension in `chrome://extensions` deletes the hash and status it stored.
- In LocWarp's mushroom map panel, "Clear login data" under "How to log in" deletes the cookies LocWarp saved.

## Contact

Questions and reports: <https://github.com/keezxc1223/locwarp/issues>.
