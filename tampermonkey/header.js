// ==UserScript==
// @name         RTA Captcha OCR
// @namespace    https://github.com/Miku0139oao/rta-captcha-chrome
// @version      1.0.17
// @description  讀畫面上的驗證碼圖；雙擊輸入欄填入。不攔截點圖換圖，不再取新圖。
// @author       Miku0139oao
// @license      MIT
// @match        https://*.rta-os.com/*
// @match        https://rta-os.com/*
// @connect      sso.rta-os.com
// @connect      mansso.rta-os.com
// @connect      partner.rta-os.com
// @grant        GM_xmlhttpRequest
// @grant        GM.xmlHttpRequest
// @run-at       document-start
// @homepageURL  https://github.com/Miku0139oao/rta-captcha-chrome
// @supportURL   https://github.com/Miku0139oao/rta-captcha-chrome/issues
// @downloadURL  https://raw.githubusercontent.com/Miku0139oao/rta-captcha-chrome/main/tampermonkey/rta-captcha.user.js
// @updateURL    https://raw.githubusercontent.com/Miku0139oao/rta-captcha-chrome/main/tampermonkey/rta-captcha.user.js
// ==/UserScript==
