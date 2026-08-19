# RTA Captcha OCR (Chrome MV3)

English | [繁體中文](README.zh-TW.md)

A loadable Chrome Manifest V3 extension that reads the RTA SSO login captcha **on your computer**. It is a JavaScript port of [`EmbeddedOCRSolver`](https://github.com/Miku0139oao/rta-sales-client-go) from [rta-sales-client-go](https://github.com/Miku0139oao/rta-sales-client-go): five hexadecimal characters (`0-9a-f`), 15×21 glyph templates, color clustering, Otsu thresholding, and fail-closed matching. There is no Tesseract, GPU, remote OCR, or 2Captcha.

The extension fills only `input#verifyCode[name="input-verify_code"]`. It does not read the account or password fields, does not submit the login form, and does not store credentials.

## Install

This is **not yet listed** on the Chrome Web Store (publishing has to be submitted from your Google account; see [STORE.md](STORE.md)). There is **no compile step**. `manifest.json` in the repository root is the extension. Download it and load it unpacked.

### Option 1: Release zip (no git, no Node)

1. Open [Releases](https://github.com/Miku0139oao/rta-captcha-chrome/releases) and download the latest `rta-captcha-chrome-*.zip`.
2. Extract it. You must see `manifest.json` inside the extracted folder.
3. Go to `chrome://extensions/`.
4. Turn on **Developer mode**.
5. Click **Load unpacked** and select the **extracted folder** (not the zip file).
6. Open `https://sso.rta-os.com/`. When the captcha image loads, the extension fills the captcha field if it is confident. You still confirm and submit the login yourself.

Microsoft Edge uses different button labels for the same flow:

1. Open `edge://extensions/`
2. Turn on **Developer mode** on the left
3. Click **Load unpacked** (Traditional Chinese UI: **載入解壓縮**)
4. Select the **extracted folder that contains `manifest.json`**, not the `.zip` file

To update later, download a new zip, overwrite the extracted folder, and click Reload on the extensions page.

### Option 2: Clone the source

```powershell
git clone https://github.com/Miku0139oao/rta-captcha-chrome.git
```

Then follow steps 3–6 above and select the cloned repository root. Do not run `npm install` or a build; the checkout is already the extension.

## How it works

| Layer | Role |
| --- | --- |
| `content.js` | Runs only on `sso.rta-os.com`. Finds `#verifyCodeMsg` and the captcha input. |
| `background.js` | Checks the sender, then fetches `https://mansso.rta-os.com/getVerifyCodeImg?verifyCodeFlag=…`. |
| `offscreen.js` | Isolated host for the OCR worker. Pages cannot open this port. |
| `ocr/worker.js` | Decodes the image and runs the solver off the login page thread. |

Uncertain answers (distance &gt; 0.20 or margin &lt; 0.02) are not filled. The content script clicks `#verifyCodeMsg` to request a new image, at most four times.

Permissions are limited to `offscreen`, `https://sso.rta-os.com/*`, and `https://mansso.rta-os.com/*`. See [README.zh-TW.md](README.zh-TW.md) for the full security notes.

## Develop

Node.js 22+ is required. No packages need installing:

```powershell
npm test
npm run verify
```

Tests include the upstream synthetic `0be7f` JPEG case and the color-noise fixture `e2c63`.

To regenerate packed templates from a checkout of `rta-sales-client-go`:

```powershell
node scripts/generate-template-data.mjs path\to\rta-sales-client-go
npm run verify
```

The generator only reads `rtasales/embedded_ocr_learned.go` and `rtasales/embedded_ocr_consensus_learned.go`. It records their SHA-256 in the generated file header. This port tracks revision `3a21e0ab9bb91d2ad033d226db6a372074f58e0e`.

## License

MIT. OCR logic and templates are derived from MIT-licensed [rta-sales-client-go](https://github.com/Miku0139oao/rta-sales-client-go). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
