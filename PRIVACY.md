# Privacy Policy — RTA Captcha OCR

Last updated: 2026-08-19

This policy applies to the Chrome / Microsoft Edge extension **RTA Captcha OCR** published from [github.com/Miku0139oao/rta-captcha-chrome](https://github.com/Miku0139oao/rta-captcha-chrome).

## What the extension does

The extension runs only on `https://sso.rta-os.com/` and fetches the captcha image from `https://mansso.rta-os.com/getVerifyCodeImg`. It reads that image, recognizes five hexadecimal characters on your computer, and may fill the captcha input (`#verifyCode`). It does not submit the login form.

## Data the extension handles

The extension processes:

- The captcha image currently shown on the RTA SSO login page
- The captcha answer it derives from that image
- The `verifyCodeFlag` query parameter on the captcha image URL (used only to request that same challenge)

This data is used solely to fill the captcha field on the same login page.

## What the extension does not collect

The extension does **not**:

- Read, store, or transmit account names or passwords
- Use `storage`, `cookies`, `history`, `tabs`, or identity APIs
- Send captcha images, answers, cookies, or form fields to the developer or to any third-party OCR / analytics / advertising service
- Include remote code, trackers, or crash reporting

OCR runs inside the extension’s own offscreen document and dedicated worker.

## Network requests

The only network request the extension makes is a same-site fetch of the captcha image URL already displayed by RTA (`https://mansso.rta-os.com/getVerifyCodeImg?verifyCodeFlag=…`). The browser may attach cookies that RTA already set for that host; the extension never reads cookie values.

No data is transmitted to `github.com`, Google, or the developer as part of solving the captcha.

## Local processing

Recognition happens on-device. Nothing is written to `chrome.storage` or to disk.

## Contact

Source and issues: [https://github.com/Miku0139oao/rta-captcha-chrome](https://github.com/Miku0139oao/rta-captcha-chrome)
