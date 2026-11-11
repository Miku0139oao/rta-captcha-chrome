// Shared page-side behaviour for both the MV3 content script and the
// Tampermonkey userscript.
//
// The two platforms differ only in how an image is turned into an answer
// (extension message to the service worker vs. an in-page worker). Everything
// else — finding the captcha, deciding whether the on-screen challenge is still
// valid, refreshing it, filling the input, and releasing resources — lives here
// so the two builds cannot drift apart again.

import { ANSWER_PATTERN } from "./protocol.js";

export const CAPTCHA_TTL_MS = 50_000;

export const DEFAULT_HINTS = Object.freeze({
  ready: "雙擊此欄或點工具列圖示即可填入驗證碼",
  busy: "正在辨識驗證碼…",
  refreshing: "驗證碼已過期，正在換一張…",
  done: "已填入。可再雙擊重新辨識",
  failed: "辨識失敗。請點驗證碼換圖後再雙擊",
  empty: "找不到驗證碼欄位或圖片",
});

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

const PREFETCH_DEBOUNCE_MS = 120;
const REFRESH_TIMEOUT_MS = 6_000;


/**
 * @param {object} options
 * @param {(image: HTMLImageElement, token: string) => Promise<string>} options.recognize
 *   Reads the captcha currently shown and resolves with a five character answer.
 *   Must reject when the answer is not trustworthy.
 * @param {() => Promise<void> | void} [options.prepare]
 *   Platform hook run on every detected image before it is read (for example
 *   adding a CORS attribute that requires a reload).
 * @param {() => void} [options.release]
 *   Platform hook invoked when the login page is left or the captcha disappears.
 * @param {() => Promise<unknown>} [options.warmup]
 *   Platform hook invoked once to pre-load the OCR engine.
 * @param {number} [options.ttlMs] Server-side challenge lifetime, conservatively
 *   under RTA's one minute.
 */
export function createCaptchaPage(options) {
  const recognize = options.recognize;
  const prepare = options.prepare ?? null;
  const release = options.release ?? null;
  const warmup = options.warmup ?? null;
  const hints = { ...DEFAULT_HINTS, ...(options.hints ?? {}) };
  const ttlMs = options.ttlMs ?? CAPTCHA_TTL_MS;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);

  let cache = emptyCache();
  let warmed = false;
  let observer = null;
  let debounceTimer = 0;
  let idleCallbackId = 0;
  let lastHref = "";
  let boundImage = null;
  let lastLoadAt = new WeakMap();
  let loadGeneration = new WeakMap();

  function emptyCache() {
    return { token: "", answer: "", solvedAt: 0, job: null };
  }

  function now() {
    return performance.now();
  }

  function install() {
    document.addEventListener("dblclick", onDoubleClick, true);
    document.addEventListener("load", onImageLoad, true);
    // A captcha that fails to load must not leave a stale answer or a refresh
    // promise hanging: both are keyed on the load timestamp, so reset it.
    document.addEventListener("error", onImageError, true);
    window.addEventListener("hashchange", onNavigation);
    window.addEventListener("popstate", onNavigation);
    window.addEventListener("pagehide", onPageHide);
    startObserver();
    lastHref = location.href;
    sync();
  }

  function isOnLoginSurface() {
    return Boolean(findCaptchaImage()) && Boolean(getCaptchaInput());
  }

  function startObserver() {
    if (observer || !document.documentElement) {
      return;
    }
    observer = new MutationObserver(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        cache = emptyCache();
      }
      scheduleSync();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src", "style", "class", "hidden", "disabled"],
    });
  }

  function scheduleSync() {
    window.clearTimeout(debounceTimer);
    cancelIdleWork();
    debounceTimer = window.setTimeout(() => {
      const run = () => {
        idleCallbackId = 0;
        sync();
      };
      if (typeof requestIdleCallback === "function") {
        idleCallbackId = requestIdleCallback(run, { timeout: 400 });
      } else {
        run();
      }
    }, PREFETCH_DEBOUNCE_MS);
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

  function sync() {
    const image = findCaptchaImage();
    const input = getCaptchaInput();
    if (!(image instanceof HTMLImageElement) || !input) {
      if (boundImage && !boundImage.isConnected) {
        boundImage = null;
      }
      return;
    }
    markCaptchaInput(input);
    if (!warmed && warmup) {
      warmed = true;
      Promise.resolve()
        .then(warmup)
        .catch(() => {
          warmed = false;
        });
    }
    if (boundImage !== image) {
      boundImage = image;
      rememberImage(image);
    }
    if (prepare) {
      try {
        prepare(image);
      } catch {
        // Preparing is a platform nicety; never let it break detection.
      }
    }
    prefetch(image);
  }

  function rememberImage(image) {
    // The challenge starts its one minute lifetime when the browser finishes
    // loading it, which is the earliest moment it could have been issued.
    if (!lastLoadAt.has(image)) {
      lastLoadAt.set(image, now());
    }
  }

  function onImageLoad(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement)) {
      return;
    }
    if (!isCaptchaCandidate(image)) {
      return;
    }
    lastLoadAt.set(image, now());
    loadGeneration.set(image, (loadGeneration.get(image) ?? 0) + 1);
    scheduleSync();
  }

  function onImageError(event) {
    const image = event.target;
    if (!(image instanceof HTMLImageElement) || !isCaptchaCandidate(image)) {
      return;
    }
    // No load event is coming, so nothing can be scheduled from this image. Drop
    // any answer bound to it instead of leaving a stale one behind.
    if (image === boundImage || imageToken(image) === cache.token) {
      cache = emptyCache();
      lastLoadAt.delete(image);
    }
  }

  function onNavigation() {
    cache = emptyCache();
    lastHref = location.href;
    if (isOnLoginSurface()) {
      scheduleSync();
      return;
    }
    teardown();
  }

  function onPageHide() {
    teardown();
  }

  function teardown() {
    window.clearTimeout(debounceTimer);
    cancelIdleWork();
    boundImage = null;
    cache = emptyCache();
    if (release) {
      try {
        release();
      } catch {
        // Releasing is best effort; the platform also has its own idle timer.
      }
    }
  }

  function onDoubleClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const input = getCaptchaInput();
    const image = findCaptchaImage();
    if (!input) {
      return;
    }
    const hitInput =
      target === input || input.contains(target) || target.closest("input") === input;
    const hitImage = Boolean(image) && target.closest("img") === image;
    if (!hitInput && !hitImage) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    // Double-clicking the image also runs the site's own click handlers, which
    // may already have started a challenge swap; fillNow waits for that.
    void fillNow(hitImage && !hitInput ? "image-click" : "input");
  }

  function imageToken(image) {
    const src = image.currentSrc || image.src || "";
    const generation = loadGeneration.get(image) ?? 0;
    return `${src}|${image.naturalWidth}x${image.naturalHeight}|g${generation}`;
  }

  function imageAge(image) {
    const loadedAt = lastLoadAt.get(image);
    return loadedAt === undefined ? Number.POSITIVE_INFINITY : now() - loadedAt;
  }

  function isChallengeFresh(image) {
    return imageAge(image) < ttlMs;
  }

  function isCachedAnswerUsable(token) {
    return (
      cache.token === token &&
      cache.answer !== "" &&
      now() - cache.solvedAt < ttlMs
    );
  }

  function prefetch(image) {
    if (
      !(image instanceof HTMLImageElement) ||
      !image.complete ||
      image.naturalWidth <= 0 ||
      !isChallengeFresh(image)
    ) {
      return;
    }
    const token = imageToken(image);
    if (cache.token === token && (cache.answer || cache.job)) {
      return;
    }
    startJob(image, token);
  }

  function startJob(image, token) {
    const job = recognize(image, token).then(
      (answer) => {
        if (!ANSWER_PATTERN.test(answer)) {
          throw new Error("ocr returned an invalid answer");
        }
        return answer;
      },
    );
    cache = { token, answer: "", solvedAt: 0, job };
    job.then(
      (answer) => {
        if (cache.token !== token || cache.job !== job) {
          return;
        }
        if (imageToken(findCaptchaImage() ?? image) !== token) {
          cache = emptyCache();
          return;
        }
        cache = { token, answer, solvedAt: now(), job: null };
        hint(getCaptchaInput(), hints.ready);
      },
      () => {
        if (cache.token === token && cache.job === job) {
          cache = { token, answer: "", solvedAt: 0, job: null };
        }
      },
    );
    return job;
  }

  async function fillNow(reason) {
    let image = findCaptchaImage();
    const input = getCaptchaInput();
    if (!(image instanceof HTMLImageElement) || !input) {
      hint(input, hints.empty);
      return;
    }
    markCaptchaInput(input);
    hint(input, hints.busy);

    try {
      if (reason === "image-click") {
        image = await settleAfterImageClick(image);
      }
      // A challenge older than its server-side lifetime can never be accepted,
      // so replace it before spending an OCR pass on it.
      if (!isChallengeFresh(image)) {
        hint(input, hints.refreshing);
        const refreshed = await refreshCaptchaImage(image);
        if (refreshed) {
          image = findCaptchaImage() ?? image;
          hint(input, hints.busy);
        }
      }

      const result = await solveForFill(image, input);
      const latest = findCaptchaImage();
      if (
        ANSWER_PATTERN.test(result.answer) &&
        latest instanceof HTMLImageElement &&
        imageToken(latest) === result.token
      ) {
        fillCaptchaInput(result.answer);
        hint(input, hints.done);
        return;
      }
      hint(input, hints.failed);
    } catch {
      hint(input, hints.failed);
    }
  }

  // Double-clicking the image cannot suppress the site's own click handlers: the
  // two `click` events fire before `dblclick` reaches us. If one of them started a
  // challenge swap, the image is mid-load and OCR would read a half-updated
  // bitmap. Only wait when that actually happened (the browser clears `complete`
  // while fetching), so the normal case costs nothing.
  function settleAfterImageClick(image) {
    if (!(image instanceof HTMLImageElement) || image.complete) {
      return Promise.resolve(image);
    }
    return new Promise((resolve) => {
      let settled = false;
      function finish() {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timer);
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", finish);
        resolve(findCaptchaImage() ?? image);
      }
      function onLoad() {
        // The site swapped in the challenge the server is now expecting.
        lastLoadAt.set(image, now());
        loadGeneration.set(image, (loadGeneration.get(image) ?? 0) + 1);
        finish();
      }
      // Bounded and short: the captcha is a few kilobytes, so a load that has
      // not landed within this window is stuck, and OCR would fail anyway.
      const timer = window.setTimeout(finish, 400);
      image.addEventListener("load", onLoad);
      image.addEventListener("error", finish);
    });
  }

  async function solveForFill(image, input) {
    let lastError = null;
    let candidate = image;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (!(candidate instanceof HTMLImageElement) || !candidate.isConnected) {
        throw lastError ?? new Error("captcha not found");
      }
      const token = imageToken(candidate);
      if (isCachedAnswerUsable(token)) {
        return { answer: cache.answer, token };
      }
      try {
        const answer =
          cache.token === token && cache.job
            ? await cache.job
            : await startJob(candidate, token);
        return { answer, token };
      } catch (error) {
        lastError = error;
        if (attempt + 1 >= maxAttempts) {
          break;
        }
        hint(input, hints.refreshing);
        const refreshed = await refreshCaptchaImage(candidate);
        if (!refreshed) {
          break;
        }
        candidate = findCaptchaImage() ?? candidate;
      }
    }
    throw lastError ?? new Error("ocr failed");
  }

  function refreshCaptchaImage(image) {
    return new Promise((resolve) => {
      if (!image.isConnected) {
        resolve(false);
        return;
      }
      const before = imageToken(image);
      let settled = false;
      const timeout = window.setTimeout(() => done(false), REFRESH_TIMEOUT_MS);
      function done(ok) {
        if (settled) {
          return;
        }
        settled = true;
        window.clearTimeout(timeout);
        image.removeEventListener("load", onLoad);
        image.removeEventListener("error", onError);
        resolve(ok);
      }
      function onLoad() {
        window.setTimeout(() => done(imageToken(image) !== before), 50);
      }
      function onError() {
        done(false);
      }
      image.addEventListener("load", onLoad);
      image.addEventListener("error", onError);
      // Same as the user clicking the image: the site fetches a fresh challenge,
      // so the on-screen pixels and the server-side answer stay in sync.
      image.click();
    });
  }

  function fillCaptchaInput(answer) {
    const input = getCaptchaInput();
    if (!input || !ANSWER_PATTERN.test(answer)) {
      return false;
    }
    // Always overwrite: a captcha typed seconds ago is already stale, and the
    // answer we just produced is bound to the challenge now on screen.
    setInputValue(input, answer);
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

  function isCaptchaCandidate(image) {
    if (!(image instanceof HTMLImageElement)) {
      return false;
    }
    if (image === boundImage || image.id === "verifyCodeMsg") {
      return true;
    }
    for (const selector of IMAGE_SELECTORS) {
      try {
        if (image.matches(selector)) {
          return true;
        }
      } catch {
        // Selector is invalid in this document type.
      }
    }
    const blob = `${image.currentSrc || ""} ${image.src || ""} ${image.id} ${
      image.className
    }`;
    return /getVerifyCodeImg|verifyCodeFlag|verifyCodeMsg|驗證碼|验证码/i.test(
      blob,
    );
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
    input.title = hints.ready;
  }

  function hint(input, text) {
    if (input) {
      input.title = text;
    }
  }

  return { install, fillNow, teardown, isOnLoginSurface };
}

export { IMAGE_SELECTORS, INPUT_SELECTORS };
