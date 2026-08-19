// ==UserScript==
// @name         RTA Captcha OCR
// @namespace    https://github.com/Miku0139oao/rta-captcha-chrome
// @version      1.0.2
// @description  在 RTA 登入頁（含 partner 跳轉、SSO iframe）以本機 OCR 填入五碼驗證碼。不讀帳密、不送出登入。
// @author       Miku0139oao
// @license      MIT
// @match        https://*.rta-os.com/*
// @match        https://rta-os.com/*
// @connect      sso.rta-os.com
// @connect      mansso.rta-os.com
// @connect      partner.rta-os.com
// @connect      *
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @run-at       document-idle
// @homepageURL  https://github.com/Miku0139oao/rta-captcha-chrome
// @supportURL   https://github.com/Miku0139oao/rta-captcha-chrome/issues
// @downloadURL  https://raw.githubusercontent.com/Miku0139oao/rta-captcha-chrome/main/tampermonkey/rta-captcha.user.js
// @updateURL    https://raw.githubusercontent.com/Miku0139oao/rta-captcha-chrome/main/tampermonkey/rta-captcha.user.js
// ==/UserScript==
