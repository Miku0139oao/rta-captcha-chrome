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
  const AUTOFILL_MARKER = "rtaCaptchaOcrAutofilled";

  let worker = null;
  let workerUrl = "";
  let workerFailed = false;
  let localSolver = null;
  let nextJobId = 1;
  const pendingJobs = new Map();
  let cache = { token: "", answer: "", error: null, job: null };
  let prefetchTimer = 0;
  let idleTimer = 0;
  const IDLE_RELEASE_MS = 20000;
  const imageLoadGeneration = new WeakMap();

  installCaptchaCorsHook();
  document.addEventListener("dblclick", onDoubleClick, true);
  document.addEventListener("load", onImageLoad, true);
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
  try {
    patchHistoryApi();
  } catch {
    // Some Tampermonkey sandboxes forbid rewriting history.
  }
  onNavigation();

  function patchHistoryApi() {
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      if (typeof original !== "function") {
        continue;
      }
      history[method] = function (...args) {
        const result = original.apply(this, args);
        onNavigation();
        return result;
      };
    }
  }

  function installCaptchaCorsHook() {
    const observe = (target) => {
      if (!target) {
        return;
      }
      const observer = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === "attributes" && mutation.target instanceof HTMLImageElement) {
            if (ensureCaptchaCors(mutation.target)) {
              continue;
            }
            if (onLoginSurface()) {
              schedulePrefetch();
            }
            continue;
          }
          for (const node of mutation.addedNodes) {
            scanForCaptchaImages(node);
          }
        }
      });
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["src"],
      });
      scanForCaptchaImages(target);
    };

    if (document.documentElement) {
      observe(document.documentElement);
      return;
    }
    const boot = new MutationObserver(() => {
      if (!document.documentElement) {
        return;
      }
      boot.disconnect();
      observe(document.documentElement);
    });
    boot.observe(document, { childList: true });
  }

  function scanForCaptchaImages(root) {
    if (root instanceof HTMLImageElement) {
      ensureCaptchaCors(root);
      return;
    }
    if (!root || typeof root.querySelectorAll !== "function") {
      return;
    }
    for (const image of root.querySelectorAll("img")) {
      ensureCaptchaCors(image);
    }
  }

  function isCaptchaImageCandidate(image) {
    if (!(image instanceof HTMLImageElement)) {
      return false;
    }
    for (const selector of IMAGE_SELECTORS) {
      try {
        if (image.matches(selector)) {
          return true;
        }
      } catch {
        // Invalid selector in this document type.
      }
    }
    const blob = [
      image.currentSrc || "",
      image.src || "",
      image.getAttribute("src") || "",
      image.id,
      image.className,
      image.alt || "",
    ].join(" ");
    return /getVerifyCodeImg|verifyCodeFlag|verifyCodeMsg|驗證碼|验证码/i.test(blob);
  }

  function ensureCaptchaCors(image) {
    if (!isCaptchaImageCandidate(image) || image.crossOrigin === "use-credentials") {
      return false;
    }
    const raw = image.getAttribute("src") || "";
    if (raw) {
      try {
        const url = new URL(raw, location.href);
        if (url.origin === location.origin) {
          return false;
        }
      } catch {
        return false;
      }
    } else if (image.id !== "verifyCodeMsg") {
      return false;
    }
    const hadSrc = Boolean(raw);
    image.crossOrigin = "use-credentials";
    return hadSrc;
  }

  function onImageLoad(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) {
      return;
    }
    if (!isCaptchaImageCandidate(image)) {
      return;
    }
    if (ensureCaptchaCors(image)) {
      return;
    }
    imageLoadGeneration.set(image, (imageLoadGeneration.get(image) || 0) + 1);
    if (onLoginSurface()) {
      schedulePrefetch();
    }
  }

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
      scanForCaptchaImages(document);
      schedulePrefetch();
      return;
    }
    releaseEngine();
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
    const generation = imageLoadGeneration.get(image) || 0;
    return `${challengeUrl(image)}|${src}|${image.naturalWidth}x${image.naturalHeight}|g${generation}`;
  }

  function prefetchCurrentCaptcha() {
    const image = findCaptchaImage();
    if (!(image instanceof HTMLImageElement) || !image.complete || image.naturalWidth <= 0) {
      return;
    }
    if (ensureCaptchaCors(image)) {
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
    const captchaInput = getCaptchaInput();
    if (!captchaInput) {
      return;
    }
    const hitInput =
      target === captchaInput ||
      captchaInput.contains(target) ||
      target.closest("input") === captchaInput;
    if (!hitInput) {
      return;
    }
    event.preventDefault();
    void fillCachedAnswer();
  }

  async function fillCachedAnswer() {
    const image = findCaptchaImage();
    const input = getCaptchaInput();
    if (!(image instanceof HTMLImageElement) || !input) {
      return;
    }
    hint(input, "正在辨識驗證碼…");
    if (ensureCaptchaCors(image) || !image.complete || image.naturalWidth <= 0) {
      try {
        await waitForCaptchaLoad(image);
      } catch {
        hint(input, "辨識失敗。請點驗證碼圖片換圖後再雙擊輸入欄");
        return;
      }
    }
    const tokenBefore = imageToken(image);
    prefetchCurrentCaptcha();
    try {
      let answer = cache.token === tokenBefore ? cache.answer : "";
      if (!answer && cache.token === tokenBefore && cache.job) {
        answer = await cache.job;
      }
      if (!answer) {
        answer = await recognize(image, tokenBefore);
        cache = { token: tokenBefore, answer, error: null, job: null };
      }
      const latest = findCaptchaImage();
      if (
        ANSWER_PATTERN.test(answer) &&
        latest instanceof HTMLImageElement &&
        imageToken(latest) === tokenBefore
      ) {
        fillCaptchaInput(answer);
        hint(input, "");
      }
    } catch {
      hint(input, "辨識失敗。請點驗證碼圖片換圖後再雙擊輸入欄");
    }
  }

  function waitForCaptchaLoad(image) {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error("captcha load timed out"));
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
        reject(new Error("captcha load failed"));
      }
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
    });
  }

  async function readVisiblePixels(image) {
    try {
      const bitmap = await createImageBitmap(image, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "none",
      });
      try {
        return bitmapToImageData(bitmap);
      } finally {
        bitmap.close();
      }
    } catch {
      return readCanvasPixels(image);
    }
  }

  function bitmapToImageData(bitmap) {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) {
      throw new Error("canvas 2d context is unavailable");
    }
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
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
      if (isCaptchaImageCandidate(image)) {
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
    hint(input, "已填入。可再雙擊重填");
    input.focus();
    input.select();
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
    return validatedCaptchaUrl(image.currentSrc || image.src) || "";
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
