# RTA Captcha OCR (Chrome MV3)

English | [繁體中文](README.zh-TW.md)

A loadable Chrome Manifest V3 extension that reads the RTA login captcha **on your computer**. It is a JavaScript port of [`EmbeddedOCRSolver`](https://github.com/Miku0139oao/rta-sales-client-go) from [rta-sales-client-go](https://github.com/Miku0139oao/rta-sales-client-go): five hexadecimal characters recognized with fail-closed template matching. There is no Tesseract, GPU, remote OCR, or 2Captcha.

It prefetches the captcha in the background and fills when you **double-click** the captcha field (or click the toolbar icon). It does not read account or password fields, does not submit the login form, and does not store credentials.

RTA expires a captcha after about one minute. The extension stops reusing an answer once the challenge is older than that, and when you ask for a fill it replaces an expired challenge first — the same thing that happens when you click the image yourself. Filling always overwrites whatever is in the field, because a half-typed or leftover code is always the wrong one by then.

You can trigger a fill by double-clicking the captcha field, double-clicking the captcha image, or clicking the toolbar icon. If recognition fails, the field is left alone and the tooltip says so.

The extension also blocks RTA's analytics collector (`logman.rta-os.com`), which otherwise sends a behavioural event on every page entry with your user id, screen size, user agent, page URL, and session counters. Blocking it does not change how the portal works.

## Install

### Tampermonkey (easiest on Edge and Chrome)

1. Install [Tampermonkey for Edge](https://microsoftedge.microsoft.com/addons/detail/tampermonkey/iikmkjmpaadaobahmlepeloendndfphd) or [for Chrome](https://chromewebstore.google.com/detail/tampermonkey/dhdgffkkebhmkfjojejmpbldmpobfkfo).
2. Open the raw userscript; Tampermonkey prompts to install:  
   https://github.com/Miku0139oao/rta-captcha-chrome/raw/main/tampermonkey/rta-captcha.user.js
3. Click **Install**. If an older copy is already installed, delete it in the Tampermonkey dashboard first and install the current release; old copies do not update reliably.
4. Open the RTA login page and double-click the captcha input to fill. You still submit the login yourself.

Violentmonkey and ScriptCat can install the same `.user.js`.

The extension is **not listed** on the Chrome Web Store. To load it instead, there is **no compile step**: `manifest.json` in the repository root is the extension.

### Option 1: Release zip (no git, no Node)

1. Open [Releases](https://github.com/Miku0139oao/rta-captcha-chrome/releases) and download the latest `rta-captcha-chrome-*.zip`.
2. Extract it. You must see `manifest.json` inside the extracted folder.
3. Go to `chrome://extensions/`.
4. Turn on **Developer mode**.
5. Click **Load unpacked** and select the **extracted folder** (not the zip file).
6. Open the RTA login page and double-click the captcha input. You still confirm and submit the login yourself.

Microsoft Edge uses different button labels for the same flow:

1. Open `edge://extensions/`
2. Turn on **Developer mode** on the left
3. Click **Load unpacked**
4. Select the **extracted folder that contains `manifest.json`**, not the `.zip` file

To update later, download a new zip, overwrite the extracted folder, and click Reload on the extensions page. Release zips are built by CI from the tagged commit, so the zip and the tag always match.

### Option 2: Clone the source

```powershell
git clone https://github.com/Miku0139oao/rta-captcha-chrome.git
```

Then follow steps 3–6 above and select the cloned repository root. Do not run `npm install` or a build; the checkout is already the extension.

## How it works

| Layer | Role |
| --- | --- |
| `lib/page-core.js` | Shared behaviour for both builds: find the captcha, track its age, refresh an expired one, prefetch, and fill. |
| `lib/tracker-hosts.js` | The telemetry host list plus the page-level blocker used by the userscript. |
| Content script | Runs only on RTA official login pages. Wires page-core to the extension transport. |
| `background.js` | Validates the sender and owns the offscreen OCR document. |
| `offscreen.js` | Isolated host for the OCR worker. Created lazily; pages cannot open this port. |
| `ocr/worker.js` | Decodes the image and runs the solver off the login page thread. |

The Tampermonkey build is produced from the same `lib/page-core.js` and `ocr/` sources, so the two cannot behave differently.

Uncertain answers are not filled. A challenge that is already past RTA's one-minute lifetime is refreshed before it is read.

Permissions are `offscreen` and `declarativeNetRequest` (static rules only, used for the telemetry blocklist), plus the RTA login hosts and the collector host. See [README.zh-TW.md](README.zh-TW.md) for the full security notes.

## Develop

Node.js 22+ is required. No packages need installing:

```powershell
npm test
npm run verify
npm run package     # deterministic extension zip in dist/
```

`npm run verify` runs the syntax check, rebuilds the userscript, verifies that the committed artefacts and versions agree with `manifest.json`, and runs the tests. `manifest.json` is the single source of truth for the version; the userscript header and `package.json` are checked against it, and CI refuses a release tag that does not match.

To regenerate packed templates from a checkout of `rta-sales-client-go`:

```powershell
node scripts/generate-template-data.mjs path\to\rta-sales-client-go
npm run verify
```

The generator also precomputes each template's topology hints, which keeps solver start-up cheap; a test verifies the hints against a fresh walk of every bitmap.

## License

MIT. OCR logic and templates are derived from MIT-licensed [rta-sales-client-go](https://github.com/Miku0139oao/rta-sales-client-go). See [LICENSE](LICENSE) and [NOTICE](NOTICE).
