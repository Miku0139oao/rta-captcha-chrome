# Privacy Policy — RTA Captcha OCR

Last updated: 2026-08-23

This policy applies to the Chrome / Microsoft Edge extension **RTA Captcha OCR** published from [github.com/Miku0139oao/rta-captcha-chrome](https://github.com/Miku0139oao/rta-captcha-chrome).

## What the extension does

The extension runs only on the official RTA login pages. It reads the captcha image already shown on screen; only if that image cannot be read locally does it request a fresh captcha from RTA's own login server. It recognizes five hexadecimal characters on your computer and fills the captcha input when you double-click the field or click the toolbar icon. It does not submit the login form.

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

The only network request the extension can make is to RTA's own server for the captcha image already displayed by the RTA login page. The browser may attach cookies that RTA already set for that host; the extension never reads cookie values.

No data is transmitted to `github.com`, Google, or the developer as part of solving the captcha.

## Local processing

Recognition happens on-device. Nothing is written to `chrome.storage` or to disk.

## Contact

Source and issues: [https://github.com/Miku0139oao/rta-captcha-chrome](https://github.com/Miku0139oao/rta-captcha-chrome)
