# RTA Captcha OCR (Chrome MV3)

English | [繁體中文](README.zh-TW.md)

A loadable Chrome Manifest V3 extension that reads the RTA login captcha **on your computer**. It is a JavaScript port of [`EmbeddedOCRSolver`](https://github.com/Miku0139oao/rta-sales-client-go) from [rta-sales-client-go](https://github.com/Miku0139oao/rta-sales-client-go): five hexadecimal characters recognized with fail-closed template matching. There is no Tesseract, GPU, remote OCR, or 2Captcha.

It prefetches the captcha in the background and fills only when you **double-click** the captcha field (or click the toolbar icon). It does not read account or password fields, does not submit the login form, and does not store credentials.

## Install

### Tampermonkey (easiest on Edge and Chrome)

1. Install [Tampermonkey for Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) or [for Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. Open the raw userscript; Tampermonkey prompts to install:  
   https://github.com/Miku0139oao/rta-captcha-chrome/raw/main/tampermonkey/rta-captcha.user.js
3. Click **Install**. If an older copy is already installed, delete it in the Tampermonkey dashboard first and install this **1.0.17** file; old copies do not update reliably.
4. Open the RTA login page. Click the captcha image to refresh it with the site's own handler. Double-click the captcha input to fill the digits you see. The script does not run automatically. You still submit the login yourself.

Violentmonkey and ScriptCat can install the same `.user.js`. Your userscript manager may ask to allow RTA domains on the first fetch; allow them.

This is **not yet listed** on the Chrome Web Store. To load it as an extension instead, there is **no compile step**. `manifest.json` in the repository root is the extension. Download it and load it unpacked.

### Option 1: Release zip (no git, no Node)

1. Open [Releases](https://github.com/Miku0139oao/rta-captcha-chrome/releases) and download the latest `rta-captcha-chrome-*.zip`.
2. Extract it. You must see `manifest.json` inside the extracted folder.
3. Go to `chrome://extensions/`.
4. Turn on **Developer mode**.
5. Click **Load unpacked** and select the **extracted folder** (not the zip file).
6. Open the RTA login page. When the captcha image appears, **double-click the captcha input** (or click the toolbar icon) to fill it. You still confirm and submit the login yourself.

Microsoft Edge uses different button labels for the same flow:

1. Open `edge://extensions/`
2. Turn on **Developer mode** on the left
3. Click **Load unpacked**
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
| Content script | Runs only on RTA official login pages. Prefetches; double-click fills. |
| `background.js` | Validates the sender, OCRs on-screen pixels when possible, otherwise fetches the captcha image from RTA's own endpoint. Releases the OCR document when idle. |
| `offscreen.js` | Isolated host for the OCR worker. Created lazily; pages cannot open this port. |
| `ocr/worker.js` | Decodes the image and runs the solver off the login page thread. |

Uncertain answers are not filled. The page is not auto-refreshed; click the captcha image yourself if you need a new one.

Permissions are limited to `offscreen` and the RTA official login hosts. See [README.zh-TW.md](README.zh-TW.md) for the full security notes.

## Develop

Node.js 22+ is required. No packages need installing:

```powershell
npm test
npm run verify
```

To regenerate packed templates from a checkout of `rta-sales-client-go`:

```powershell
node scripts/generate-template-data.mjs path\to\rta-sales-client-go
npm run verify
```

## License

MIT. OCR logic and templates are derived from MIT-licensed [rta-sales-client-go](https://github.com/Miku0139oao/rta-sales-client-go). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
