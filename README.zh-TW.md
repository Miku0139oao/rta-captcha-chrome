# RTA Captcha OCR（Chrome MV3）

[English](README.md) | 繁體中文

這是一個完全離線辨識 RTA 登入驗證碼的 Chrome Manifest V3 擴充功能。OCR 是 `rta-sales-client-go` `EmbeddedOCRSolver` 的 JavaScript 移植版，固定辨識 5 位十六進位字元。辨識結果不夠確定時不猜答案；不會自動換圖，也不會送出表單。

驗證碼圖會在背景先辨識；**快速雙擊驗證碼輸入欄**（或點工具列圖示）才填入。它不會讀取帳號或密碼欄位、不會提交登入表單，也不會儲存登入資料。

## 安裝

### 方法零：Tampermonkey（Edge / Chrome 都適用，最簡單）

1. 先裝 [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)（Edge）或 [Chrome 版](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)。
2. 打開這支腳本的 Raw 頁，Tampermonkey 會跳出安裝：  
   https://github.com/Miku0139oao/rta-captcha-chrome/raw/main/tampermonkey/rta-captcha.user.js
3. 按「安裝」。
4. 開啟 RTA 登入頁。驗證碼圖會在背景先辨識；**快速雙擊驗證碼輸入欄**才填入。頁面上沒有浮層。登入仍由你送出。
5. 若已安裝舊版，到 Tampermonkey 儀表板刪除後重裝（版本需為 **1.0.9**）。

Violentmonkey、ScriptCat 同樣可安裝這支 `.user.js`。第一次取圖時腳本管理器可能詢問是否允許 RTA 網域，選允許。

目前**尚未上架** Chrome 線上應用程式商店。若要改裝成擴充功能：沒有需要編譯的步驟。倉庫根目錄裡的 `manifest.json` 就是擴充功能；下載後用 Chrome「載入未封裝項目」即可。

### 方法一：下載 Release zip（不用 git、不用 Node）

1. 打開 [Releases](https://github.com/Miku0139oao/rta-captcha-chrome/releases)，下載最新的 `rta-captcha-chrome-*.zip`。
2. 解壓縮到任意資料夾。解出來的目錄裡必須看得到 `manifest.json`。
3. Chrome 網址列輸入 `chrome://extensions/` 後 Enter。
4. 右上角打開「開發人員模式」。
5. 按「載入未封裝項目」，選**解壓縮後的那個資料夾**（不要選 zip 檔本身）。
6. 開啟 RTA 登入頁。圖出來後**雙擊驗證碼輸入欄**（或點工具列圖示）填入；登入仍由你自己確認後送出。

Microsoft Edge 按鈕名稱不同，流程一樣：

1. 打開 `edge://extensions/`
2. 左側打開「開發人員模式」
3. 按「**載入解壓縮**」（這就是 Chrome 的「載入未封裝項目」）
4. 選**已經解壓縮、裡面有 `manifest.json` 的資料夾**，不要選 `.zip` 檔

之後若擴充功能更新，再下載新的 zip、覆蓋解壓目錄，然後在擴充功能頁按重新整理。

### 方法二：clone 原始碼

```powershell
git clone https://github.com/Miku0139oao/rta-captcha-chrome.git
```

然後依方法一的第 3–6 步，選 clone 下來的倉庫根目錄（含 `manifest.json` 的那層）。不必執行 `npm install` 或任何 build。

## MV3 架構

資料流分成四個隔離層：

1. Content script 只在 RTA 官方登入頁執行；優先讀取畫面上已顯示的驗證碼像素，雙擊才填入。
2. `background.js` 驗證訊息來源後執行本機 OCR；必要時才向 RTA 官方驗證碼端點取得圖片。
3. `offscreen.html` / `offscreen.js` 透過經過來源驗證的私有 port 承載 OCR Worker，頁面內容無法直接取得此 port。
4. `ocr/worker.js` 在 dedicated Web Worker 內解碼與辨識，不占用登入頁面的主執行緒。

Worker 只回傳符合固定格式的答案。兩種正規化模型不一致、距離過大或最佳與次佳差距不足時會 fail closed。無法辨識時不會自動換圖、不會碰觸其他按鈕或送出表單；請自行點驗證碼圖換一張後再雙擊。

## 權限理由

權限刻意維持最小範圍：

| 權限 | 用途 |
| --- | --- |
| `offscreen` | 建立不顯示 UI 的 extension document，以承載本機 OCR Worker。 |
| RTA 登入頁 host | 只在官方登入頁載入 content script，並驗證訊息來源。 |
| RTA 驗證碼圖片 host | 只取得該頁實際顯示的驗證碼圖片。 |

沒有要求 `activeTab`、`cookies`、`history`、`scripting`、`storage`、`tabs`、`webRequest` 或 `<all_urls>`，也沒有 `web_accessible_resources`。

## 安全與隱私

- 無遠端程式碼：所有 JavaScript、OCR 邏輯與模板都包在擴充功能中，CSP 僅允許 `'self'`，禁止 object、inline script 與 eval。
- 無外部 OCR：圖片不會傳給第三方 OCR、分析、遙測或記錄服務；程式沒有第三方網路端點。
- Cookie 不外洩：驗證碼請求使用瀏覽器原生 `credentials: "include"`，Cookie 只會由瀏覽器直接送往 RTA 官方主機。程式沒有 `cookies` 權限，不讀取 `document.cookie`，也看不到或記錄 Cookie 值。
- 不存憑證：程式沒有 storage 權限，不讀取、雜湊、記錄或傳送任何憑證。
- 僅填驗證碼：只針對登入頁的驗證碼輸入欄位；DOM 契約不符時直接停止。
- 不覆蓋手動輸入：驗證碼欄位已有使用者輸入時不覆蓋其內容。
- 不自動登入：不點擊登入按鈕、不送出表單。使用者仍需自行檢查並送出。
- 不記錄敏感內容：production code 不輸出圖片、答案、URL 或表單內容到 console。
- 有界資源：圖片大小與像素數有上限、網路與 OCR 都有 timeout；離開登入頁或閒置時釋放 OCR 資源。

## 測試與驗證

需求為 Node.js 22 以上，不需要 `npm install`：

```powershell
npm test
npm run check:syntax
npm run verify
```

測試涵蓋合成驗證碼辨識、彩色雜訊 regression fixture、uncertainty fail-closed、輸入尺寸、glyph topology、雙 extraction margin 與 packed overlap 距離，以及 Manifest V3 權限最小化、嚴格 CSP、無遠端程式碼、無 eval、content/service-worker/offscreen/dedicated-worker 分層。

## 更新內建模板

已產生的 `ocr/templates.generated.js` 可獨立執行，不依賴 Go repository。若要從唯讀的 `rta-sales-client-go` checkout 更新模板：

```powershell
node scripts/generate-template-data.mjs path\to\rta-sales-client-go
npm run verify
```

產生檔頭會記錄來源檔的 SHA-256，方便稽核。

## 授權

OCR 邏輯與模板衍生自 MIT 授權的 `rta-sales-client-go`；詳見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。
