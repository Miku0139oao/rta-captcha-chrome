  const IMAGE_SELECTORS = [
    "img#verifyCodeMsg",
    'img[src*="getVerifyCodeImg"]',
    'img[src*="verifyCodeFlag"]',
  ];
  const INPUT_SELECTORS = [
    'input#verifyCode[name="input-verify_code"]',
    "input#verifyCode",
    'input[name="input-verify_code"]',
    'input[name="verifyCode"]',
    "input#verifycode",
  ];
  const FLAG_PATTERN = /^[0-9a-f]{32}$/i;
  const ANSWER_PATTERN = /^[0-9a-f]{5}$/;
  const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
  const AUTOFILL_MARKER = "rtaCaptchaOcrAutofilled";

  let worker = null;
  let workerUrl = "";
  let workerFailed = false;
  let localSolver = null;
  let nextJobId = 1;
  const pendingJobs = new Map();
  let cache = { token: "", answer: "", error: null, job: null };
  let observer = null;
  let prefetchTimer = 0;
  let idleTimer = 0;
  const IDLE_RELEASE_MS = 20000;

  document.addEventListener("dblclick", onDoubleClick, true);
  document.addEventListener(
    "load",
    (event) => {
      if (event.target instanceof HTMLImageElement) {
        if (event.target.dataset.rtaOcrIgnoreLoad === "1") {
          delete event.target.dataset.rtaOcrIgnoreLoad;
          return;
        }
        if (onLoginSurface()) {
          schedulePrefetch();
        }
      }
    },
    true,
  );
  document.addEventListener(
    "input",
    (event) => {
      if (
        event.isTrusted &&
        event.target instanceof HTMLInputElement &&
        event.target === getCaptchaInput()
      ) {
        delete event.target.dataset[AUTOFILL_MARKER];
      }
    },
    true,
  );
  window.addEventListener("hashchange", onNavigation);
  window.addEventListener("popstate", onNavigation);
  onNavigation();

  function onLoginSurface() {
    const host = location.hostname.toLowerCase();
    const hash = location.hash || "";
    if (/sso|mansso/i.test(host) || /login|sso/i.test(hash)) {
      return true;
    }
    return Boolean(findCaptchaImage());
  }

  function onNavigation() {
    cache = { token: "", answer: "", error: null, job: null };
    if (onLoginSurface()) {
      ensureObserver();
      schedulePrefetch();
      return;
    }
    stopObserver();
    releaseEngine();
  }

  function ensureObserver() {
    if (observer || !document.documentElement) {
      return;
    }
    observer = new MutationObserver(schedulePrefetch);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });
  }

  function stopObserver() {
    if (!observer) {
      return;
    }
    observer.disconnect();
    observer = null;
  }

  function ensureWorker() {
    if (worker || workerFailed) {
      return worker;
    }
    try {
      workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      worker = new Worker(workerUrl);
      worker.addEventListener("message", (event) => {
        const message = event.data || {};
        const pending = pendingJobs.get(message.id);
        if (!pending) {
          return;
        }
        pendingJobs.delete(message.id);
        if (message.ok && ANSWER_PATTERN.test(message.answer)) {
          pending.resolve(message.answer);
          return;
        }
        const error = new Error(message.message || "ocr failed");
        error.code = message.code;
        pending.reject(error);
      });
      return worker;
    } catch {
      workerFailed = true;
      worker = null;
      return null;
    }
  }

  function releaseEngine() {
    window.clearTimeout(idleTimer);
    idleTimer = 0;
    for (const pending of pendingJobs.values()) {
      pending.reject(new Error("ocr released"));
    }
    pendingJobs.clear();
    if (worker) {
      worker.terminate();
      worker = null;
    }
    if (workerUrl) {
      URL.revokeObjectURL(workerUrl);
      workerUrl = "";
    }
    localSolver = null;
  }

  function bumpIdleRelease() {
    window.clearTimeout(idleTimer);
    idleTimer = window.setTimeout(() => {
      releaseEngine();
    }, IDLE_RELEASE_MS);
  }

  function schedulePrefetch() {
    if (!onLoginSurface()) {
      return;
    }
    window.clearTimeout(prefetchTimer);
    prefetchTimer = window.setTimeout(() => {
      const run = () => void prefetchCurrentCaptcha();
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: 400 });
      } else {
        run();
      }
    }, 200);
  }

  function imageToken(image) {
    const src = image.currentSrc || image.src || "";
    return `${challengeUrl(image)}|${src}|${image.naturalWidth}x${image.naturalHeight}`;
  }

  function prefetchCurrentCaptcha() {
    const image = findCaptchaImage();
    if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth <= 0) {
      return;
    }
    if (!challengeUrl(image)) {
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
        if (cache.token === token) {
          cache = { token, answer, error: null, job: null };
        }
        bumpIdleRelease();
      },
      (error) => {
        if (cache.token === token) {
          cache = { token, answer: "", error, job: null };
        }
        bumpIdleRelease();
      },
    );
  }

  async function recognize(image, token) {
    const pixels = await readVisiblePixels(image);
    if (imageToken(image) !== token) {
      throw new Error("captcha changed");
    }
    return ocrPixels(pixels);
  }

  function ocrPixels(pixels) {
    const activeWorker = ensureWorker();
    if (activeWorker) {
      const id = nextJobId;
      nextJobId += 1;
      const buffer = pixels.data.buffer;
      bumpIdleRelease();
      return new Promise((resolve, reject) => {
        pendingJobs.set(id, { resolve, reject });
        try {
          activeWorker.postMessage(
            { id, width: pixels.width, height: pixels.height, buffer },
            [buffer],
          );
        } catch {
          const copy = buffer.slice(0);
          activeWorker.postMessage(
            { id, width: pixels.width, height: pixels.height, buffer: copy },
            [copy],
          );
        }
      });
    }
    return new Promise((resolve, reject) => {
      const run = () => {
        try {
          resolve(getLocalSolver().solve(pixels));
        } catch (error) {
          reject(error);
        }
      };
      if (typeof requestIdleCallback === "function") {
        requestIdleCallback(run, { timeout: 800 });
      } else {
        window.setTimeout(run, 0);
      }
    });
  }

  function getLocalSolver() {
    if (!localSolver) {
      localSolver = new Function(`${OCR_CORE}; return new EmbeddedOCRSolver();`)();
    }
    return localSolver;
  }

  function onDoubleClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const input = target.closest("input") || getCaptchaInput();
    const image = target.closest("img");
    const captchaInput = getCaptchaInput();
    const captchaImage = findCaptchaImage();
    const hitInput =
      captchaInput &&
      (target === captchaInput || captchaInput.contains(target) || input === captchaInput);
    const hitImage = captchaImage && image === captchaImage;
    if (!hitInput && !hitImage) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    void fillCachedAnswer();
  }

  async function fillCachedAnswer() {
    const image = findCaptchaImage();
    const input = getCaptchaInput();
    if (!(image instanceof HTMLImageElement) || !input) {
      return;
    }
    const token = imageToken(image);
    prefetchCurrentCaptcha();
    try {
      let answer = cache.token === token ? cache.answer : "";
      if (!answer && cache.token === token && cache.job) {
        answer = await cache.job;
      }
      if (!answer) {
        answer = await recognize(image, token);
        cache = { token, answer, error: null, job: null };
      }
      if (ANSWER_PATTERN.test(answer) && imageToken(findCaptchaImage() || image) === token) {
        fillCaptchaInput(answer);
      }
    } catch {
      return;
    }
  }

  async function readVisiblePixels(image) {
    try {
      return readCanvasPixels(image);
    } catch {
      const url = challengeUrl(image);
      if (!url || url.startsWith("blob:")) {
        throw new Error("cannot read captcha pixels");
      }
      const bytes = await fetchCaptchaBytes(url);
      await showFetchedImage(image, url, bytes);
      return bytesToImageData(bytes);
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

  function showFetchedImage(image, originalUrl, bytes) {
    const blob = new Blob([bytes]);
    const blobUrl = URL.createObjectURL(blob);
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("blob image load timed out"));
      }, 4000);
      function cleanup() {
        window.clearTimeout(timeout);
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
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

  function findCaptchaImage() {
    for (const selector of IMAGE_SELECTORS) {
      const image = document.querySelector(selector);
      if (image instanceof HTMLImageElement && isVisible(image)) {
        return image;
      }
    }
    for (const image of document.images) {
      if (!(image instanceof HTMLImageElement) || !isVisible(image)) {
        continue;
      }
      const blob = `${image.currentSrc || ""} ${image.src || ""} ${image.id} ${image.className} ${image.alt || ""} ${image.dataset.rtaOcrOriginal || ""}`;
      if (/getVerifyCodeImg|verifyCodeFlag|verifyCodeMsg|驗證碼|验证码/i.test(blob)) {
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
    for (const input of document.querySelectorAll("input")) {
      if (!isUsableCaptchaInput(input)) {
        continue;
      }
      const blob = `${input.name} ${input.id} ${input.className} ${input.placeholder || ""} ${input.getAttribute("aria-label") || ""}`;
      if (/verify|captcha|驗證碼|验证码|驗証/i.test(blob)) {
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

  function gmRequest() {
    if (typeof GM_xmlhttpRequest === "function") {
      return GM_xmlhttpRequest;
    }
    if (typeof GM !== "undefined" && typeof GM.xmlHttpRequest === "function") {
      return GM.xmlHttpRequest;
    }
    return null;
  }

  function fetchCaptchaBytes(url) {
    const request = gmRequest();
    if (!request) {
      return Promise.reject(new Error("GM_xmlhttpRequest is unavailable"));
    }
    return new Promise((resolve, reject) => {
      request({
        method: "GET",
        url,
        responseType: "arraybuffer",
        anonymous: false,
        timeout: 12000,
        headers: {
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
        },
        onload(response) {
          if (response.status < 200 || response.status >= 300) {
            reject(new Error(`captcha HTTP ${response.status}`));
            return;
          }
          const buffer = response.response;
          if (!(buffer instanceof ArrayBuffer) || buffer.byteLength === 0) {
            reject(new Error("empty captcha image"));
            return;
          }
          if (buffer.byteLength > MAX_IMAGE_BYTES) {
            reject(new Error("captcha image is too large"));
            return;
          }
          const bytes = new Uint8Array(buffer);
          if (!hasImageSignature(bytes)) {
            reject(new Error("captcha response is not an image"));
            return;
          }
          resolve(bytes);
        },
        onerror: () => reject(new Error("captcha request failed")),
        ontimeout: () => reject(new Error("captcha request timed out")),
      });
    });
  }

  function hasImageSignature(bytes) {
    const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    const png =
      bytes.length >= 8 &&
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47;
    const gif = bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
    const webp =
      bytes.length >= 12 &&
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50;
    return jpeg || png || gif || webp;
  }

  async function bytesToImageData(bytes) {
    const bitmap = await createImageBitmap(new Blob([bytes]));
    try {
      const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) {
        throw new Error("canvas 2d context is unavailable");
      }
      context.drawImage(bitmap, 0, 0);
      return context.getImageData(0, 0, bitmap.width, bitmap.height);
    } finally {
      bitmap.close();
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
    return true;
  }

  function setInputValue(input, value) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
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
      if (url.protocol === "blob:") {
        return "";
      }
      if (url.protocol !== "https:") {
        return "";
      }
      if (!/(^|\.)rta-os\.com$/i.test(url.hostname)) {
        return "";
      }
      const flag = url.searchParams.get("verifyCodeFlag");
      const looksLikeCaptcha =
        /getVerifyCodeImg/i.test(`${url.pathname}${url.search}`) || Boolean(flag);
      if (!looksLikeCaptcha) {
        return "";
      }
      if (flag && !FLAG_PATTERN.test(flag)) {
        return "";
      }
      return url.href;
    } catch {
      return "";
    }
  }
