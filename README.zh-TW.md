# RTA Captcha OCR（Chrome MV3）

[English](README.md) | 繁體中文

這是一個完全離線辨識 RTA SSO 驗證碼的 Chrome Manifest V3 擴充功能。OCR 是 `rta-sales-client-go` `EmbeddedOCRSolver` 的 JavaScript 移植版，固定辨識 5 位十六進位字元，使用內建的 15×21 learned、supplemental 與 fitted 模板。辨識結果不夠確定時不猜答案，而是要求頁面換一張驗證碼；連續自動刷新最多 4 次。

擴充功能只會填入目前 RTA 登入頁的 `input#verifyCode[name="input-verify_code"]`。它不會讀取帳號或密碼欄位、不會提交登入表單，也不會儲存登入資料。

## 安裝

### 方法零：Tampermonkey（Edge / Chrome 都適用，最簡單）

1. 先裝 [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)（Edge）或 [Chrome 版](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)。
2. 打開這支腳本的 Raw 頁，Tampermonkey 會跳出安裝：  
   https://github.com/Miku0139oao/rta-captcha-chrome/raw/main/tampermonkey/rta-captcha.user.js
3. 按「安裝」。
4. 開啟 `https://sso.rta-os.com/` 登入頁。驗證碼圖片出現後會自動填入；登入仍由你送出。

Violentmonkey、ScriptCat 同樣可安裝這支 `.user.js`。第一次向 `mansso.rta-os.com` 取圖時，Tampermonkey 可能問你是否允許網域，選允許。

目前**尚未出現在 Chrome 線上應用程式商店**（上架必須用你的 Google 帳號送審，步驟見 [STORE.md](STORE.md)）。若要改裝成擴充功能：沒有需要編譯的步驟。倉庫根目錄裡的 `manifest.json` 就是擴充功能；下載後用 Chrome「載入未封裝項目」即可。

### 方法一：下載 Release zip（不用 git、不用 Node）

1. 打開 [Releases](https://github.com/Miku0139oao/rta-captcha-chrome/releases) ，下載最新的 `rta-captcha-chrome-*.zip`。
2. 解壓縮到任意資料夾。解出來的目錄裡必須看得到 `manifest.json`。
3. Chrome 網址列輸入 `chrome://extensions/` 後 Enter。
4. 右上角打開「開發人員模式」。
5. 按「載入未封裝項目」，選**解壓縮後的那個資料夾**（不要選 zip 檔本身）。
6. 開啟 `https://sso.rta-os.com/` 登入頁。驗證碼圖片載入後，擴充功能會在本機辨識並填入驗證碼欄位；登入仍由你自己確認後送出。

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

資料流刻意分成四個隔離層：

1. `content.js` 僅在 `sso.rta-os.com` 最上層頁面執行，只尋找已確認的驗證碼圖片與驗證碼輸入框。
2. `background.js` 驗證訊息來源、頁框、URL host、path、query 名稱與 32 位 flag，然後只向 `mansso.rta-os.com/getVerifyCodeImg` 取得圖片。
3. `offscreen.html` / `offscreen.js` 透過經過來源驗證的私有 long-lived port 接收工作，頁面內容無法直接取得此 port。
4. `ocr/worker.js` 在 dedicated Web Worker 內解碼圖片，`ocr/solver.js` 執行 OCR。OCR 不占用 RTA 頁面的主執行緒。

Worker 只回傳符合 `^[0-9a-f]{5}$` 的答案。兩種正規化模型不一致、距離大於 `0.20`，或最佳與次佳的 margin 小於 `0.02` 時會 fail closed。無法辨識時，content script 只會對 `#verifyCodeMsg` 觸發刷新，不會碰觸其他按鈕或送出表單。

## 權限理由

`manifest.json` 的權限刻意維持最小範圍：

| 權限 | 用途 |
| --- | --- |
| `offscreen` | 建立不顯示 UI 的 extension document，以承載本機 OCR Worker。 |
| `https://sso.rta-os.com/*` | 只在正式 RTA SSO 頁面載入 content script，並驗證訊息來源。 |
| `https://mansso.rta-os.com/*` | 只取得實際的 RTA 驗證碼圖片；程式另行把 path 鎖定為 `/getVerifyCodeImg`，並嚴格驗證唯一的 `verifyCodeFlag` query。Chrome match pattern 無法把 host permission 限制到單一路徑，因此再由程式執行 path allowlist。 |

沒有要求 `activeTab`、`cookies`、`history`、`scripting`、`storage`、`tabs`、`webRequest` 或 `<all_urls>`，也沒有 `web_accessible_resources`。

## 安全與隱私

- 無遠端程式碼：所有 JavaScript、OCR 邏輯與模板都包在擴充功能中，CSP 僅允許 `'self'`，禁止 object、inline script 與 eval。
- 無外部 OCR：圖片不會傳給第三方 OCR、分析、遙測或記錄服務；程式沒有第三方網路端點。
- Cookie 不外洩：驗證碼請求使用瀏覽器原生 `credentials: "include"`，Cookie 最多只會由瀏覽器直接送往 allowlist 中的 `mansso.rta-os.com`。程式沒有 `cookies` 權限，不讀取 `document.cookie`，也看不到或記錄 Cookie 值。
- 不存憑證：程式沒有 storage 權限，不查詢 `#account` 或 `#password`，不讀取、雜湊、記錄或傳送任何憑證。
- 僅填驗證碼：目標必須同時是 `input#verifyCode`、name 為 `input-verify_code`、type 為 `text`，且不得具有 password autocomplete 語意。DOM 契約不符時直接停止。
- 不覆蓋手動輸入：驗證碼欄位已有使用者輸入時不啟動新工作；使用者在辨識期間自行輸入時也不覆蓋其內容。
- 不自動登入：沒有點擊 `#login` 或呼叫 form submission。使用者仍需自行檢查並送出。
- 不記錄敏感內容：production code 不輸出圖片、答案、flag、URL、表單內容或錯誤細節到 console。
- 有界資源：圖片上限 4 MiB、解碼像素上限 2,000,000、網路與 OCR 都有 timeout，自動刷新也有上限。

RTA 的驗證碼 endpoint 對相同 flag 再請求時會產生新的圖片，因此 background 會在頁面圖片完成載入後才取得最新 challenge。若取得圖片後的本機解碼或 OCR 失敗，頁面必須刷新，避免畫面仍顯示已失效的舊圖。

## 測試與驗證

需求為 Node.js 22 以上，不需要 `npm install`：

```powershell
npm test
npm run check:syntax
npm run verify
```

測試涵蓋：

- 與 Go 測試相同的 `0be7f` 合成驗證碼辨識。
- 上游 `e2c63` 彩色雜訊 regression fixture，驗證 topology review 不會把被雜訊封口的 `c` 猜成閉環字元。
- uncertainty fail-closed、輸入尺寸、glyph topology、雙 extraction margin 與 packed overlap 距離。
- Manifest V3、精確 host allowlist、權限最小化、嚴格 CSP、無遠端程式碼、無 eval。
- content/service-worker/offscreen/dedicated-worker 分層，以及 content script 不含帳號或密碼 selector。

## 更新內建模板

已產生的 `ocr/templates.generated.js` 可獨立執行，不依賴 Go repository。若要從唯讀的 `rta-sales-client-go` checkout 更新模板：

```powershell
node scripts/generate-template-data.mjs path\to\rta-sales-client-go
npm run verify
```

產生器只讀取：

- `rtasales/embedded_ocr_learned.go`
- `rtasales/embedded_ocr_consensus_learned.go`

產生檔頭會記錄兩個來源檔的 SHA-256，方便稽核。這次移植的來源 revision 是 `3a21e0ab9bb91d2ad033d226db6a372074f58e0e`。

## 授權

OCR 邏輯與模板衍生自 MIT 授權的 `rta-sales-client-go`；詳見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。
