// MV3 service worker.
//
// Validates every sender, owns the offscreen document that hosts the OCR worker,
// and answers content-script solve requests. It never touches the page DOM.

import {
  ANSWER_PATTERN,
  FILL_MESSAGE_TYPE,
  MAX_IMAGE_BYTES,
  MESSAGE_TYPE,
  OFFSCREEN_IDLE_MESSAGE_TYPE,
  OFFSCREEN_PAGE,
  OFFSCREEN_PORT_NAME,
  RELEASE_MESSAGE_TYPE,
  REQUEST_ID_PATTERN,
  WARMUP_MESSAGE_TYPE,
  hasImageSignature,
  isTrustedSSOPageUrl,
  parsePixelJob,
  validateCaptchaUrl,
} from "./lib/protocol.js";

const OFFSCREEN_URL = chrome.runtime.getURL(OFFSCREEN_PAGE);
const FETCH_TIMEOUT_MS = 12_000;
const OCR_TIMEOUT_MS = 20_000;
const IDLE_RELEASE_MS = 20_000;

let offscreenPort = null;
let offscreenCreation = null;
let idleTimer = null;
const portWaiters = new Set();
const pendingJobs = new Map();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== OFFSCREEN_PORT_NAME || !isOffscreenSender(port.sender)) {
    port.disconnect();
    return;
  }

  if (offscreenPort && offscreenPort !== port) {
    offscreenPort.disconnect();
  }
  offscreenPort = port;
  port.onMessage.addListener(handleOffscreenMessage);
  port.onDisconnect.addListener(() => {
    if (offscreenPort === port) {
      offscreenPort = null;
      rejectPendingJobs(new Error("Offscreen OCR connection closed"));
    }
  });

  for (const waiter of portWaiters) {
    waiter.resolve(port);
  }
  portWaiters.clear();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === OFFSCREEN_IDLE_MESSAGE_TYPE) {
    if (!isOffscreenSender(sender)) {
      sendResponse({ ok: false, reason: "rejected" });
      return false;
    }
    void releaseOffscreen().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === RELEASE_MESSAGE_TYPE) {
    if (!isTrustedContentSender(sender)) {
      sendResponse({ ok: false, reason: "rejected" });
      return false;
    }
    void releaseOffscreen().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === WARMUP_MESSAGE_TYPE) {
    if (!isTrustedContentSender(sender)) {
      sendResponse({ ok: false, reason: "rejected" });
      return false;
    }
    void warmupEngine().then(sendResponse);
    return true;
  }
  if (message?.type !== MESSAGE_TYPE) {
    return false;
  }
  void handleContentRequest(message, sender).then(sendResponse);
  return true;
});

chrome.action.onClicked.addListener((tab) => {
  if (!Number.isInteger(tab?.id)) {
    return;
  }
  chrome.tabs
    .sendMessage(tab.id, { type: FILL_MESSAGE_TYPE })
    .catch(() => undefined);
});

async function handleContentRequest(message, sender) {
  if (
    !isTrustedContentSender(sender) ||
    !REQUEST_ID_PATTERN.test(String(message.requestId ?? ""))
  ) {
    return { ok: false, reason: "rejected" };
  }

  const pixels = parsePixelJob(message);
  if (pixels) {
    try {
      const result = await sendOCRJob(pixels);
      bumpIdleRelease();
      return sanitizeSolveResult(result);
    } catch {
      return { ok: false, reason: "unreadable" };
    }
  }

  let captchaUrl;
  try {
    captchaUrl = validateCaptchaUrl(message.imageUrl);
  } catch {
    return { ok: false, reason: "rejected" };
  }

  let imageBase64;
  try {
    imageBase64 = bytesToBase64(await fetchCaptchaBytes(captchaUrl));
  } catch {
    return { ok: false, reason: "temporary-failure" };
  }

  try {
    const result = await sendOCRJob({ imageBase64 });
    bumpIdleRelease();
    return { ...sanitizeSolveResult(result), imageBase64 };
  } catch {
    return { ok: false, reason: "unreadable", imageBase64 };
  }
}

function sanitizeSolveResult(result) {
  if (result?.ok && ANSWER_PATTERN.test(result.answer)) {
    return { ok: true, answer: result.answer };
  }
  return {
    ok: false,
    reason: result?.reason === "uncertain" ? "uncertain" : "unreadable",
  };
}

function isTrustedContentSender(sender) {
  if (sender?.id !== chrome.runtime.id || typeof sender.url !== "string") {
    return false;
  }
  try {
    return isTrustedSSOPageUrl(sender.url);
  } catch {
    return false;
  }
}

function isOffscreenSender(sender) {
  if (sender?.id !== chrome.runtime.id || typeof sender.url !== "string") {
    return false;
  }
  try {
    const expected = new URL(OFFSCREEN_URL);
    const actual = new URL(sender.url);
    return actual.origin === expected.origin && actual.pathname === expected.pathname;
  } catch {
    return false;
  }
}

async function fetchCaptchaBytes(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      credentials: "include",
      redirect: "error",
      referrer: "",
      referrerPolicy: "no-referrer",
      headers: {
        Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
      },
      signal: controller.signal,
    });
    if (!response.ok || response.url !== url) {
      throw new Error("Captcha request failed");
    }
    const declaredLength = Number(response.headers.get("content-length"));
    if (
      Number.isFinite(declaredLength) &&
      (declaredLength <= 0 || declaredLength > MAX_IMAGE_BYTES)
    ) {
      throw new Error("Captcha response length is invalid");
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || !hasImageSignature(bytes)) {
      throw new Error("Captcha response is not a supported image");
    }
    return bytes;
  } finally {
    clearTimeout(timeout);
  }
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function warmupEngine() {
  try {
    await sendOCRJob({ warmup: true });
    bumpIdleRelease();
    return { ok: true };
  } catch {
    return { ok: false, reason: "temporary-failure" };
  }
}

async function sendOCRJob(job) {
  const port = await ensureOffscreenPort();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingJobs.delete(id);
      reject(new Error("OCR timed out"));
    }, OCR_TIMEOUT_MS);
    pendingJobs.set(id, { resolve, reject, timeout });
    try {
      if (job.warmup) {
        port.postMessage({ type: "warmup", id });
      } else if (job.buffer instanceof ArrayBuffer) {
        port.postMessage(
          {
            type: "solve",
            id,
            width: job.width,
            height: job.height,
            buffer: job.buffer,
          },
          [job.buffer],
        );
      } else {
        port.postMessage({ type: "solve", id, imageBase64: job.imageBase64 });
      }
    } catch (error) {
      clearTimeout(timeout);
      pendingJobs.delete(id);
      reject(error);
    }
  });
}

function handleOffscreenMessage(message) {
  if (!REQUEST_ID_PATTERN.test(String(message?.id ?? ""))) {
    return;
  }
  const pending = pendingJobs.get(message.id);
  if (!pending) {
    return;
  }
  pendingJobs.delete(message.id);
  clearTimeout(pending.timeout);
  if (message.ok === true && message.warmed === true) {
    pending.resolve({ ok: true, warmed: true });
    return;
  }
  if (message.ok === true && ANSWER_PATTERN.test(String(message.answer ?? ""))) {
    pending.resolve({ ok: true, answer: message.answer });
    return;
  }
  pending.resolve({
    ok: false,
    reason: message.reason === "uncertain" ? "uncertain" : "ocr-failed",
  });
}

function rejectPendingJobs(error) {
  for (const pending of pendingJobs.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  pendingJobs.clear();
}

function bumpIdleRelease() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    void releaseOffscreen();
  }, IDLE_RELEASE_MS);
}

async function releaseOffscreen() {
  clearTimeout(idleTimer);
  idleTimer = null;
  if (pendingJobs.size > 0) {
    bumpIdleRelease();
    return;
  }
  if (offscreenPort) {
    offscreenPort.disconnect();
    offscreenPort = null;
  }
  offscreenCreation = null;
  await chrome.offscreen.closeDocument().catch(() => undefined);
}

async function ensureOffscreenPort() {
  if (offscreenPort) {
    return offscreenPort;
  }
  await ensureOffscreenDocument();
  if (offscreenPort) {
    return offscreenPort;
  }
  try {
    return await waitForOffscreenPort(4_000);
  } catch {
    await chrome.offscreen.closeDocument().catch(() => undefined);
    offscreenCreation = null;
    await ensureOffscreenDocument();
    return waitForOffscreenPort(4_000);
  }
}

async function ensureOffscreenDocument() {
  if (offscreenCreation) {
    return offscreenCreation;
  }
  offscreenCreation = (async () => {
    if (await hasOffscreenDocument()) {
      return;
    }
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PAGE,
        reasons: ["BLOBS"],
        justification:
          "Decode local captcha image bytes and host the bundled OCR worker.",
      });
    } catch (error) {
      // Chrome 109–115 have no getContexts, so a document created by an earlier
      // wake-up is invisible to hasOffscreenDocument and createDocument throws.
      // Treat "already exists" as success: the port handshake below decides
      // whether it is actually usable.
      if (!/single offscreen/i.test(String(error?.message ?? error))) {
        throw error;
      }
    }
  })();
  try {
    await offscreenCreation;
  } finally {
    offscreenCreation = null;
  }
}

async function hasOffscreenDocument() {
  // getContexts exists from Chrome 116; the manifest floor is 109. Below that
  // there is no supported way to enumerate offscreen documents (clients.matchAll
  // in a service worker never reports them), so report "unknown" and let
  // createDocument's duplicate-document error be handled by the caller.
  if (typeof chrome.runtime.getContexts !== "function") {
    return false;
  }
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL],
  });
  return contexts.length > 0;
}

function waitForOffscreenPort(timeoutMs) {
  if (offscreenPort) {
    return Promise.resolve(offscreenPort);
  }
  return new Promise((resolve, reject) => {
    const waiter = {
      resolve: (port) => {
        clearTimeout(timeout);
        resolve(port);
      },
    };
    const timeout = setTimeout(() => {
      portWaiters.delete(waiter);
      reject(new Error("Offscreen OCR did not connect"));
    }, timeoutMs);
    portWaiters.add(waiter);
  });
}
