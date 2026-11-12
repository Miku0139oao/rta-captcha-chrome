# RTA Captcha OCR（Chrome MV3）

[English](README.md) | 繁體中文

這是一個完全離線辨識 RTA 登入驗證碼的 Chrome Manifest V3 擴充功能。OCR 是 `rta-sales-client-go` `EmbeddedOCRSolver` 的 JavaScript 移植版，固定辨識 5 位十六進位字元。辨識結果不夠確定時不猜答案，也不會送出表單。

驗證碼圖會在背景先辨識；**快速雙擊驗證碼輸入欄、雙擊驗證碼圖片，或點工具列圖示**才填入。它不會讀取帳號或密碼欄位、不會提交登入表單，也不會儲存登入資料。

RTA 的驗證碼大約一分鐘後失效，因此：

- 超過有效期限的辨識結果不會再被填入。
- 雙擊時若畫面上那張已經過期，會先換一張再辨識；這跟使用者自己點驗證碼圖換圖是同一件事。
- 填入時**一律覆蓋**欄位內容。留著先前打一半或舊的驗證碼只會讓登入失敗，覆蓋掉才符合實際狀況。

三個入口都會觸發填入：雙擊驗證碼輸入欄、雙擊驗證碼圖片、點工具列圖示。辨識失敗時不動欄位，只在提示裡說明。

擴充功能同時阻擋 RTA 的分析遙測主機 `logman.rta-os.com`。該主機每次頁面進入都會送出事件，內含使用者 ID、螢幕解析度、User-Agent、頁面 URL 與工作階段計數。阻擋不影響後台功能。

## 安裝

### 方法零：Tampermonkey（Edge / Chrome 都適用，最簡單）

1. 先裝 [Tampermonkey](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd)（Edge）或 [Chrome 版](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo)。
2. 打開這支腳本的 Raw 頁，Tampermonkey 會跳出安裝：  
   https://github.com/Miku0139oao/rta-captcha-chrome/raw/main/tampermonkey/rta-captcha.user.js
3. 按「安裝」。
4. 開啟 RTA 登入頁。驗證碼圖會在背景先辨識；**快速雙擊驗證碼輸入欄或圖片**才填入。頁面上沒有浮層。登入仍由你送出。
5. 若已安裝舊版，到 Tampermonkey 儀表板刪除後重裝。

Violentmonkey、ScriptCat 同樣可安裝這支 `.user.js`。第一次取圖時腳本管理器可能詢問是否允許 RTA 網域，選允許。

> **雙擊沒反應時**，多半是 Chrome 根本沒有執行這支腳本。從 Chrome 138 起，Tampermonkey 必須先開啟「允許使用者指令碼」才會執行：
> `chrome://extensions` → **篡改猴** → **詳細資料** → 打開「**允許使用者指令碼**」。
> Tampermonkey 儀表板的「工具」頁也會顯示同樣的提示。這是 Chrome 的設定而不是腳本設定，所以**重裝腳本不會修好**。

目前**尚未上架** Chrome 線上應用程式商店。若要改裝成擴充功能：沒有需要編譯的步驟。倉庫根目錄裡的 `manifest.json` 就是擴充功能；下載後用 Chrome「載入未封裝項目」即可。

### 方法一：下載 Release zip（不用 git、不用 Node）

1. 打開 [Releases](https://github.com/Miku0139oao/rta-captcha-chrome/releases)，下載最新的 `rta-captcha-chrome-*.zip`。
2. 解壓縮到任意資料夾。解出來的目錄裡必須看得到 `manifest.json`。
3. Chrome 網址列輸入 `chrome://extensions/` 後 Enter。
4. 右上角打開「開發人員模式」。
5. 按「載入未封裝項目」，選**解壓縮後的那個資料夾**（不要選 zip 檔本身）。
6. 開啟 RTA 登入頁。圖出來後**雙擊驗證碼輸入欄或圖片**（或點工具列圖示）填入；登入仍由你自己確認後送出。

Microsoft Edge 按鈕名稱不同，流程一樣：

1. 打開 `edge://extensions/`
2. 左側打開「開發人員模式」
3. 按「**載入解壓縮**」（這就是 Chrome 的「載入未封裝項目」）
4. 選**已經解壓縮、裡面有 `manifest.json` 的資料夾**，不要選 `.zip` 檔

之後若擴充功能更新，再下載新的 zip、覆蓋解壓目錄，然後在擴充功能頁按重新整理。Release zip 由 CI 從被標記的 commit 產生，因此 zip 與 tag 一定對應。

### 方法二：clone 原始碼

```powershell
git clone https://github.com/Miku0139oao/rta-captcha-chrome.git
```

然後依方法一的第 3–6 步，選 clone 下來的倉庫根目錄（含 `manifest.json` 的那層）。不必執行 `npm install` 或任何 build。

## 疑難排解

| 症狀 | 原因 |
| --- | --- |
| 雙擊沒有反應，欄位提示文字也從來沒變 | 腳本沒有在執行。請開啟 Tampermonkey 的「允許使用者指令碼」（見上方）。 |
| 提示「辨識失敗」 | 辨識信心不足。請自己點一下驗證碼換圖，再雙擊一次。 |
| 有填入但網站說驗證碼錯誤 | 驗證碼已過期；RTA 只保留約一分鐘。再雙擊一次換新的。 |
| Network 仍看得到 `logman.rta-os.com` | 只有擴充功能能在網路層阻擋；Tampermonkey 版同樣要求 Chrome 有在執行腳本（第一列）。 |

## MV3 架構

資料流分成五個隔離層：

1. `lib/page-core.js` 是擴充功能與 Tampermonkey 共用的頁面邏輯：找驗證碼、計算有效期限、必要時換圖、預先辨識、填入。
2. `content.js` 由 `src/content.js` 打包產生，只在 RTA 官方登入頁執行，接上 extension 的傳輸層。
3. `background.js` 驗證訊息來源後執行本機 OCR；必要時才向 RTA 官方驗證碼端點取得圖片。
4. `offscreen.html` / `offscreen.js` 透過經過來源驗證的私有 port 承載 OCR Worker，頁面內容無法直接取得此 port。
5. `ocr/worker.js` 在 dedicated Web Worker 內解碼與辨識，不占用登入頁面的主執行緒。

另外有兩個不參與 OCR 的檔案：`lib/protocol.js` 集中管理訊息名稱、URL 契約與答案格式；`lib/tracker-hosts.js` 與 `rules/trackers.json` 定義要封鎖的遙測主機。

Tampermonkey 版由同一份 `lib/page-core.js` 與 `ocr/` 產生，兩邊行為不會分岔。

Worker 只回傳符合固定格式的答案。兩種正規化模型不一致、距離過大或最佳與次佳差距不足時會 fail closed。無法辨識時會換一張再試一次；仍失敗就停手，不會碰觸登入按鈕或送出表單。

## 權限理由

權限維持在實際需要的最小集合。`declarativeNetRequest` 是為了封鎖遙測才加入的，且只使用靜態規則：

| 權限 | 用途 |
| --- | --- |
| `offscreen` | 建立不顯示 UI 的 extension document，以承載本機 OCR Worker。 |
| RTA 登入頁 host | 只在官方登入頁載入 content script，並驗證訊息來源。 |
| RTA 驗證碼圖片 host | 只取得該頁實際顯示的驗證碼圖片。 |
| `declarativeNetRequest` | 只用靜態規則檔封鎖分析遙測主機，執行期不會新增或修改規則。 |
| RTA 分析主機 host | 只為了讓靜態封鎖規則能命中該主機；程式不對它發出任何請求。 |

沒有要求 `activeTab`、`cookies`、`history`、`scripting`、`storage`、`tabs`、`webRequest` 或 `<all_urls>`，也沒有 `web_accessible_resources`。

## 安全與隱私

- 無遠端程式碼：所有 JavaScript、OCR 邏輯與模板都包在擴充功能中，CSP 僅允許 `'self'`，禁止 object、inline script 與 eval。
- 無外部 OCR：圖片不會傳給第三方 OCR、分析、遙測或記錄服務；程式不對外發出任何請求，只會封鎖 RTA 自己的遙測主機。
- Cookie 不外洩：驗證碼請求使用瀏覽器原生 `credentials: "include"`，Cookie 只會由瀏覽器直接送往 RTA 官方主機。程式沒有 `cookies` 權限，不讀取 `document.cookie`，也看不到或記錄 Cookie 值。
- 不存憑證：程式沒有 storage 權限，不讀取、雜湊、記錄或傳送任何憑證。
- 僅填驗證碼：只針對登入頁的驗證碼輸入欄位；DOM 契約不符時直接停止。
- 強制覆蓋舊輸入：欄位裡舊的或打一半的驗證碼一定已經失效，因此填入時直接覆蓋。
- 不自動登入：不點擊登入按鈕、不送出表單。使用者仍需自行檢查並送出。
- 不記錄敏感內容：production code 不輸出圖片、答案、URL 或表單內容到 console。
- 阻擋遙測：以靜態 `declarativeNetRequest` 規則封鎖 `logman.rta-os.com`；Tampermonkey 版改在 document-start 攔截 `fetch`／`XMLHttpRequest`／`sendBeacon`。被攔下的請求不會離開瀏覽器，也不會轉送到其他地方。
- 有界資源：圖片大小與像素數有上限、網路與 OCR 都有 timeout；離開登入頁或閒置時釋放 OCR 資源。

## 測試與驗證

需求為 Node.js 22 以上，不需要 `npm install`：

```powershell
npm test
npm run build       # 重新產生 content.js 與 userscript
npm run verify      # 語法檢查、建置、版本與產物一致性、測試
npm run package     # 產生可重現的擴充功能 zip 到 dist/
```

`content.js` 與 `tampermonkey/rta-captcha.user.js` 都是產生檔且已提交。要改行為請改 `src/content.js`、`lib/` 與 `ocr/`，再跑 `npm run build`；若提交的產物與來源不一致，CI 會失敗。

兩者都必須是 classic script：content script 只要含有 `import` 就是語法錯誤，Chrome 會直接丟棄整個檔案且不會回報，因此測試會用 `vm.Script` 以 classic script 編譯它們。

測試涵蓋合成驗證碼辨識、彩色雜訊 regression fixture、uncertainty fail-closed、輸入尺寸、glyph topology、預先算好的 topology 與實際 bitmap 一致、重複分類的快取、雙 extraction margin 與 packed overlap 距離、驗證碼有效期限與必填覆蓋、遙測封鎖規則與主機清單一致、產物可否作為 classic script 載入，以及 Manifest V3 權限、嚴格 CSP、無遠端程式碼、無 eval、content/service-worker/offscreen/dedicated-worker 分層。

## 更新內建模板

已產生的 `ocr/templates.generated.js` 可獨立執行，不依賴 Go repository。若要從唯讀的 `rta-sales-client-go` checkout 更新模板：

```powershell
node scripts/generate-template-data.mjs path\to\rta-sales-client-go
npm run verify
```

產生檔頭會記錄來源檔的 SHA-256，方便稽核。產生器也會預先算好每個模板的 topology，讓 solver 啟動不必重跑 flood fill；測試會逐一比對這些預先算好的值。

## 授權

OCR 邏輯與模板衍生自 MIT 授權的 `rta-sales-client-go`；詳見 [LICENSE](LICENSE) 與 [NOTICE](NOTICE)。
