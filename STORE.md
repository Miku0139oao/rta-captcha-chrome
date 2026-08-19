# Chrome Web Store 上架說明

擴充功能可以上架，但**必須用你的 Google 帳號**在 [Chrome 開發人員後台](https://chrome.google.com/webstore/devconsole) 送審。這個倉庫沒有商店 API 金鑰，我無法替你按「發布」。

驗證碼類擴充功能有被拒的風險。本套件只在 RTA SSO 填可見驗證碼、本機 OCR、不送出登入，比「全網破解 captcha」安全，但仍可能被審核員依 circumvention / 自動化政策退回。

## 你要先有的東西

1. Google 帳號
2. 一次性 **US$5** 開發人員註冊費：https://chrome.google.com/webstore/devconsole
3. 可能要完成開發人員身分驗證
4. 本倉庫 `store/chrome-web-store.zip`（只含擴充功能檔，不含測試碼）
5. 隱私權政策網址（送審欄位必填）：  
   https://github.com/Miku0139oao/rta-captcha-chrome/blob/main/PRIVACY.md
6. 商店圖示：`store/icon-128.png`
7. 商店截圖：`store/screenshot-1280x800.png`（至少一張 1280×800 或 640×400）

## 後台上架步驟

1. 打開 https://chrome.google.com/webstore/devconsole
2. 付費並通過註冊（若尚未註冊）
3. **新增項目** → 上傳 `store/chrome-web-store.zip`
4. 商店資訊建議填：

   | 欄位 | 建議 |
   | --- | --- |
   | 名稱 | RTA Captcha OCR |
   | 簡短說明 | 在 RTA SSO 登入頁以本機 OCR 填入五碼驗證碼，不讀取帳密、不送出登入。 |
   | 詳細說明 | 見下方「商店詳細說明」 |
   | 類別 | Productivity 或 Accessibility |
   | 語言 | 中文（繁體） |
   | 可見度 | 未列出（只有連結可安裝）或公開 |
   | 隱私權政策 | 上面的 PRIVACY.md 網址 |

5. **單一用途**：協助使用者在 RTA SSO 登入頁辨識畫面上的驗證碼圖片。
6. **權限說明**（後台問卷請據實填）：
   - `offscreen`：在獨立文件跑 OCR Worker，不占用登入頁執行緒。
   - `https://sso.rta-os.com/*`：只在正式登入頁注入 content script。
   - `https://mansso.rta-os.com/*`：只抓該頁已顯示的 `/getVerifyCodeImg` 圖片。
   - 遠端程式碼：沒有。
   - 使用者資料：只在本機處理驗證碼圖片與答案，不上傳。
7. 上傳 `store/icon-128.png` 與 `store/screenshot-1280x800.png`。
8. 送審。審核常要數小時到數天。

Edge 附加元件中心是另一個後台（https://partner.microsoft.com/dashboard/microsoftedge/overview），zip 可沿用，但要另建上市項目。

## 商店詳細說明（可直接貼）

RTA Captcha OCR 只在 RTA 合作夥伴 SSO 登入頁（sso.rta-os.com）運作。

它會讀取頁面上的驗證碼圖片，在你的電腦裡用內建 OCR 辨識五位十六進位字元，並在有把握時填入驗證碼欄位。它不會讀取帳號或密碼，也不會按下登入。

特色：

- 完全本機辨識，沒有 Tesseract，也沒有遠端 OCR / 2Captcha
- 不確定時不亂填，最多自動換圖 4 次
- 權限僅限 sso.rta-os.com 與 mansso.rta-os.com
- 原始碼公開：https://github.com/Miku0139oao/rta-captcha-chrome

OCR 移植自 https://github.com/Miku0139oao/rta-sales-client-go 的 EmbeddedOCRSolver。
