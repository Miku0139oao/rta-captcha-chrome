(() => {
  "use strict";

  const MESSAGE_TYPE = "RTA_CAPTCHA_SOLVE";
  const WARMUP_MESSAGE_TYPE = "RTA_CAPTCHA_WARMUP";
  const RELEASE_MESSAGE_TYPE = "RTA_CAPTCHA_RELEASE";
  const FILL_MESSAGE_TYPE = "RTA_CAPTCHA_FILL";
  const IMAGE_SELECTORS = [
    "img#verifyCodeMsg",
    'img[src*="getVerifyCodeImg"]',
    'img[src*="verifyCodeFlag"]',
  ];
  const INPUT_SELECTORS = [
    'input#verifyCode[name="input-verify_code"]',
    "input#verifyCode",
    'input[name="input-verify_code"]',
  ];
  const CAPTCHA_ORIGIN = "https://mansso.rta-os.com";
  const CAPTCHA_PATH = "/getVerifyCodeImg";
  const CAPTCHA_FLAG_PATTERN = /^[0-9a-f]{32}$/i;
  const ANSWER_PATTERN = /^[0-9a-f]{5}$/;
  const HINT_READY = "雙擊此欄或點工具列圖示即可填入驗證碼";
  const HINT_BUSY = "正在辨識驗證碼…";
  const HINT_DONE = "已填入。可再雙擊重填，或點驗證碼換圖";
  const HINT_FAIL = "辨識失敗。點驗證碼換圖後再雙擊";
  const AUTOFILL_MARKER = "rtaCaptchaOcrAutofilled";

  let cache = emptyCache();
  let warmed = false;
  let presenceObserver = null;
  let imageObserver = null;
  let boundImage = null;
  let prefetchTimer = 0;
  let idleCallbackId = 0;

  document.addEventListener("dblclick", onDoubleClick, true);
  document.addEventListener("load", onImageLoad, true);
  document.addEventListener("input", onManualInput, true);
  window.addEventListener("hashchange", onNavigation);
  window.addEventListener("popstate", onNavigation);
  window.addEventListener("pagehide", releaseIfLeftLogin);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== FILL_MESSAGE_TYPE) {
      return false;
    }
    void fillCachedAnswer().then(() => sendResponse({ ok: true }));
    return true;
  });
  patchHistoryApi();
  onNavigation();

  function patchHistoryApi() {
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      if (typeof original !== "function" || original.rtaPatched === true) {
        continue;
      }
      const patched = function (...args) {
        const result = original.apply(this, args);
        onNavigation();
        return result;
      };
      try {
        patched.rtaPatched = true;
      } catch {
        // Non-extensible function; still safe to assign.
      }
      history[method] = patched;
    }
  }

  function emptyCache() {
    return { token: "", answer: "", error: null, job: null };
  }

  function onLoginSurface() {
    const host = location.hostname.toLowerCase();
    if (host === "sso.rta-os.com" || host === "mansso.rta-os.com") {
      return true;
    }
    const route = `${location.pathname}${location.search}${location.hash}`;
    if (host === "partner.rta-os.com" && /login|sso|auth/i.test(route)) {
      return true;
    }
    return Boolean(document.querySelector(IMAGE_SELECTORS.join(",")));
  }

  function onNavigation() {
    cache = emptyCache();
    if (onLoginSurface()) {
      ensurePresenceObserver();
      attachIfPresent();
      schedulePrefetch();
      return;
    }
    teardownWatchers();
    releaseIfLeftLogin();
  }

  function releaseIfLeftLogin() {
    if (onLoginSurface()) {
      return;
    }
    teardownWatchers();
    chrome.runtime.sendMessage({ type: RELEASE_MESSAGE_TYPE }).catch(() => undefined);
  }

  function ensurePresenceObserver() {
    if (presenceObserver || !document.documentElement) {
      return;
    }
    presenceObserver = new MutationObserver(() => {
      attachIfPresent();
    });
    presenceObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });
  }

  function attachIfPresent() {
    const image = findCaptchaImage();
    const input = getCaptchaInput();
    if (!(image instanceof HTMLImageElement) || !input) {
      if (boundImage && !boundImage.isConnected) {
        detachImage();
        ensurePresenceObserver();
      }
      return;
    }
    markCaptchaInput(input);
    if (!warmed) {
      void warmup();
    }
    if (boundImage === image) {
      return;
    }
    detachImage();
    boundImage = image;
    imageObserver = new MutationObserver(schedulePrefetch);
    imageObserver.observe(image, { attributes: true, attributeFilter: ["src"] });
    if (presenceObserver) {
      presenceObserver.disconnect();
      presenceObserver = null;
    }
    schedulePrefetch();
  }

  function detachImage() {
    imageObserver?.disconnect();
    imageObserver = null;
    boundImage = null;
  }

  function teardownWatchers() {
    window.clearTimeout(prefetchTimer);
    cancelIdleWork();
    presenceObserver?.disconnect();
    presenceObserver = null;
    detachImage();
  }

  function cancelIdleWork() {
    if (!idleCallbackId) {
      return;
    }
    if (typeof cancelIdleCallback === "function") {
      cancelIdleCallback(idleCallbackId);
    }
    idleCallbackId = 0;
  }

  function onImageLoad(event) {
    if (!(event.target instanceof HTMLImageElement)) {
      return;
    }
    if (event.target.dataset.rtaOcrIgnoreLoad === "1") {
      delete event.target.dataset.rtaOcrIgnoreLoad;
      return;
    }
    if (!onLoginSurface()) {
      return;
    }
    attachIfPresent();
    schedulePrefetch();
  }

  function onManualInput(event) {
    if (
      event.isTrusted &&
      event.target instanceof HTMLInputElement &&
      event.target === getCaptchaInput()
    ) {
      delete event.target.dataset[AUTOFILL_MARKER];
    }
  }

  function onDoubleClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const captchaInput = getCaptchaInput();
    const captchaImage = findCaptchaImage();
    const hitInput =
      captchaInput &&
      (target === captchaInput || captchaInput.contains(target));
    const hitImage = captchaImage && target.closest("img") === captchaImage;
    if (!hitInput && !hitImage) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void fillCachedAnswer();
  }

  function schedulePrefetch() {
    if (!onLoginSurface()) {
      return;
    }
    window.clearTimeout(prefetchTimer);
    cancelIdleWork();
    prefetchTimer = window.setTimeout(() => {
      const run = () => {
        idleCallbackId = 0;
        void prefetchCurrentCaptcha();
      };
      if (typeof requestIdleCallback === "function") {
        idleCallbackId = requestIdleCallback(run, { timeout: 400 });
      } else {
        run();
      }
    }, 120);
  }

  async function warmup() {
    if (warmed) {
      return;
    }
    warmed = true;
    try {
      await chrome.runtime.sendMessage({ type: WARMUP_MESSAGE_TYPE });
    } catch {
      warmed = false;
    }
  }

  function imageToken(image) {
    const src =
      image.dataset.rtaOcrOriginal || image.currentSrc || image.src || "";
    return `${src}|${image.naturalWidth}x${image.naturalHeight}`;
  }

  function prefetchCurrentCaptcha() {
    const image = findCaptchaImage();
    if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth <= 0) {
      return;
    }
    const token = imageToken(image);
    if (cache.token === token && (cache.answer || cache.job || cache.error)) {
      return;
    }
    const job = recognize(image, token);
    cache = { token, answer: "", error: null, job };
    void job.then(
      (answer) => {
        if (cache.token !== token) {
          return;
        }
        // Only keep the answer if the on-screen captcha is still the one
        // that was recognized; otherwise drop it instead of mis-keying.
        if (imageToken(image) === token) {
          cache = { token, answer, error: null, job: null };
          hint(getCaptchaInput(), HINT_READY);
        } else {
          cache = emptyCache();
        }
      },
      (error) => {
        if (cache.token !== token) {
          return;
        }
        if (imageToken(image) === token) {
          cache = { token, answer: "", error, job: null };
        } else {
          cache = emptyCache();
        }
      },
    );
  }

  async function recognize(image, token) {
    try {
      const pixels = readCanvasPixels(image);
      if (imageToken(image) !== token) {
        throw new Error("captcha changed");
      }
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE,
        requestId: crypto.randomUUID(),
        width: pixels.width,
        height: pixels.height,
        buffer: pixels.data.buffer,
      });
      return readAnswer(response);
    } catch {
      const imageUrl = challengeUrl(image);
      if (!imageUrl) {
        throw new Error("cannot read captcha");
      }
      const response = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPE,
        requestId: crypto.randomUUID(),
        imageUrl,
      });
      if (typeof response?.imageBase64 === "string" && response.imageBase64) {
        await showFetchedImage(image, imageUrl, response.imageBase64);
      }
      return readAnswer(response);
    }
  }

  function readAnswer(response) {
    if (response?.ok === true && ANSWER_PATTERN.test(String(response.answer ?? ""))) {
      return response.answer;
    }
    const error = new Error(response?.reason || "ocr failed");
    error.reason = response?.reason;
    throw error;
  }

  async function fillCachedAnswer() {
    const image = findCaptchaImage();
    const input = getCaptchaInput();
    if (!(image instanceof HTMLImageElement) || !input) {
      return;
    }
    markCaptchaInput(input);
    hint(input, HINT_BUSY);
    const token = imageToken(image);
    prefetchCurrentCaptcha();
    try {
      let answer = cache.token === token ? cache.answer : "";
      if (!answer && cache.token === token && cache.job) {
        answer = await cache.job;
      }
      if (!answer) {
        answer = await recognize(image, token);
        cache = { token: imageToken(image), answer, error: null, job: null };
      }
      if (
        ANSWER_PATTERN.test(answer) &&
        imageToken(findCaptchaImage() || image) === token
      ) {
        fillCaptchaInput(answer);
        hint(input, HINT_DONE);
      } else {
        hint(input, HINT_FAIL);
      }
    } catch {
      hint(input, HINT_FAIL);
    }
  }

  function readCanvasPixels(image) {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (width < 8 || height < 16) {
      throw new Error("captcha image is too small");
    }
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("canvas 2d context is unavailable");
    }
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height);
  }

  function showFetchedImage(image, originalUrl, imageBase64) {
    const bytes = base64ToBytes(imageBase64);
    const blobUrl = URL.createObjectURL(new Blob([bytes]));
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("blob image load timed out"));
      }, 4000);
      function cleanup() {
        window.clearTimeout(timeout);
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
        URL.revokeObjectURL(blobUrl);
      }
      function onLoad() {
        cleanup();
        resolve();
      }
      function onError() {
        cleanup();
        reject(new Error("blob image failed to load"));
      }
      image.dataset.rtaOcrOriginal = originalUrl;
      image.dataset.rtaOcrIgnoreLoad = "1";
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      image.src = blobUrl;
    });
  }

  function base64ToBytes(imageBase64) {
    const binary = atob(imageBase64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  }

  function findCaptchaImage() {
    for (const selector of IMAGE_SELECTORS) {
      const image = document.querySelector(selector);
      if (image instanceof HTMLImageElement && isVisible(image)) {
        return image;
      }
    }
    return null;
  }

  function getCaptchaInput() {
    for (const selector of INPUT_SELECTORS) {
      const input = document.querySelector(selector);
      if (isUsableCaptchaInput(input)) {
        return input;
      }
    }
    return null;
  }

  function isUsableCaptchaInput(input) {
    if (!(input instanceof HTMLInputElement) || !isVisible(input) || input.disabled) {
      return false;
    }
    const type = (input.type || "text").toLowerCase();
    if (type === "password" || type === "hidden" || type === "email" || type === "submit") {
      return false;
    }
    const auto = (input.autocomplete || "").toLowerCase();
    if (auto === "current-password" || auto === "new-password") {
      return false;
    }
    return true;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function markCaptchaInput(input) {
    if (input.dataset.rtaOcrHint === "1") {
      return;
    }
    input.dataset.rtaOcrHint = "1";
    hint(input, HINT_READY);
  }

  function hint(input, text) {
    if (input) {
      input.title = text;
    }
  }

  function fillCaptchaInput(answer) {
    const input = getCaptchaInput();
    if (!input || !ANSWER_PATTERN.test(answer)) {
      return false;
    }
    setInputValue(input, answer);
    input.dataset[AUTOFILL_MARKER] = "true";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.focus();
    input.select();
    return true;
  }

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      "value",
    );
    if (typeof descriptor?.set === "function") {
      descriptor.set.call(input, value);
    } else {
      input.value = value;
    }
  }

  function challengeUrl(image) {
    if (!image) {
      return "";
    }
    return (
      validatedCaptchaUrl(image.currentSrc || image.src) ||
      image.dataset.rtaOcrOriginal ||
      ""
    );
  }

  function validatedCaptchaUrl(value) {
    if (!value) {
      return "";
    }
    try {
      const url = new URL(value, location.href);
      const keys = [...url.searchParams.keys()];
      const flags = url.searchParams.getAll("verifyCodeFlag");
      if (
        url.origin !== CAPTCHA_ORIGIN ||
        url.pathname !== CAPTCHA_PATH ||
        url.username !== "" ||
        url.password !== "" ||
        url.hash !== "" ||
        keys.length !== 1 ||
        keys[0] !== "verifyCodeFlag" ||
        flags.length !== 1 ||
        !CAPTCHA_FLAG_PATTERN.test(flags[0])
      ) {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }
})();
