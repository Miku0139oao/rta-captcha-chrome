# Privacy Policy — RTA Captcha OCR

Last updated: 2026-11-12

This policy applies to the Chrome / Microsoft Edge extension **RTA Captcha OCR** published from [github.com/Miku0139oao/rta-captcha-chrome](https://github.com/Miku0139oao/rta-captcha-chrome).

## What the extension does

The extension runs only on the official RTA login pages. It reads the captcha image shown on screen, recognizes five hexadecimal characters on your computer, and fills the captcha input when you double-click the field or click the toolbar icon. It does not submit the login form.

If the browser will not let the extension read the on-screen pixels (RTA serves the captcha without a cross-origin header), the extension requests that same captcha image from RTA's own login server instead, so it can read the identical challenge.

RTA expires a captcha after about one minute. When a challenge has expired, asking for a fill first replaces it with a new one, exactly as clicking the image would. An answer is never filled for a challenge the server has already dropped, and the captcha field is always overwritten because any previous value is stale.

## Data the extension handles

The extension processes:

- The captcha image currently shown on the RTA login page
- The captcha answer it derives from that image

This data is used solely to fill the captcha field on the same login page.

## What the extension does not collect

The extension does **not**:

- Read, store, or transmit account names or passwords
- Use `storage`, `cookies`, `history`, `tabs`, or identity APIs
- Send captcha images, answers, cookies, or form fields to the developer or to any third-party OCR / analytics / advertising service
- Include remote code, trackers, or crash reporting

OCR runs inside the extension's own offscreen document and dedicated worker.

## Network requests

The only network request the extension can make is to RTA's own server for the captcha image displayed by the RTA login page (or, when the pixels are unreadable, for the same challenge URL). The browser may attach cookies that RTA already set for that host; the extension never reads cookie values.

No data is transmitted to `github.com`, Google, or the developer as part of solving the captcha.

## Local processing

Recognition happens on-device. Nothing is written to `chrome.storage` or to disk. The extension keeps at most one captcha answer in memory, only while a login page is open, and discards it when you leave the page or once the challenge expires.

## Contact

Source and issues: [https://github.com/Miku0139oao/rta-captcha-chrome](https://github.com/Miku0139oao/rta-captcha-chrome)
