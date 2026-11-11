// Tampermonkey page layer. Bundled by scripts/build-userscript.mjs, which inlines
// lib/page-core.js, lib/tracker-hosts.js and the OCR core above this file.
//
// Only the platform transport lives here: turning the visible image into pixels,
// keeping OCR in a worker, and releasing it when idle. Captcha discovery, the
// one minute lifetime, refresh and fill behaviour all come from page-core so this
// build cannot drift away from the extension.

// Runs at document-start, before any of the site's own scripts, so the analytics
// SDK is captured before it can send an event.
installTrackerBlocker();

const page = createCaptchaPage({
  recognize: recognizeCaptcha,
  prepare: ensureCaptchaCors,
  warmup: warmupEngine,
  release: releaseEngine,
  hints: {
    ready: "雙擊此欄或點工具列圖示即可填入驗證碼",
    busy: "正在辨識驗證碼…",
    refreshing: "驗證碼已過期，正在換一張…",
    done: "已填入。可再雙擊重新辨識",
    failed: "辨識失敗。請點驗證碼換圖後再雙擊",
  },
});

const engine = createOcrEngine();
page.install();

function createOcrEngine() {
  let worker = null;
  let workerUrl = "";
  let workerFailed = false;
  let localSolver = null;
  let nextJobId = 1;
  let idleTimer = 0;
  const pendingJobs = new Map();
  const IDLE_RELEASE_MS = 20_000;

  function ensureWorker() {
    if (worker || workerFailed) {
      return worker;
    }
    try {
      workerUrl = URL.createObjectURL(
        new Blob([WORKER_SOURCE], { type: "text/javascript" }),
      );
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

  function release() {
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
    idleTimer = window.setTimeout(release, IDLE_RELEASE_MS);
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
      localSolver = new EmbeddedOCRSolver();
    }
    return localSolver;
  }

  return { ocrPixels, release, warmup: ensureWorker };
}

async function recognizeCaptcha(image) {
  const pixels = await readVisiblePixels(image);
  const answer = await engine.ocrPixels(pixels);
  return answer;
}

async function warmupEngine() {
  engine.warmup();
}

function releaseEngine() {
  engine.release();
}

// The site serves the captcha image from a different origin, so a canvas read
// only works once the element carries a credentials CORS attribute, and adding it
// forces the browser to re-request the image. That is why this is a prepare hook
// rather than something the recogniser does inline: page-core waits for the
// resulting load before it treats the challenge as fresh.
function ensureCaptchaCors(image) {
  if (!(image instanceof HTMLImageElement)) {
    return;
  }
  if (image.crossOrigin === "use-credentials") {
    return;
  }
  const raw = image.getAttribute("src") || "";
  if (!raw) {
    return;
  }
  try {
    const url = new URL(raw, location.href);
    if (url.origin === location.origin) {
      return;
    }
    if (!/^https?:$/.test(url.protocol)) {
      return;
    }
  } catch {
    return;
  }
  if (!/getVerifyCodeImg|verifyCodeFlag|verifyCodeMsg/i.test(raw)) {
    return;
  }
  image.crossOrigin = "use-credentials";
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
