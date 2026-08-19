import {
  ANSWER_PATTERN,
  REQUEST_ID_PATTERN,
  hasImageSignature,
  isTrustedSSOPageUrl,
  validateCaptchaUrl,
} from "./lib/protocol.js";

const CONTENT_MESSAGE_TYPE = "RTA_CAPTCHA_SOLVE";
const OFFSCREEN_PORT_NAME = "rta-ocr-offscreen-v1";
const OFFSCREEN_URL = chrome.runtime.getURL("offscreen.html");
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12_000;
const OCR_TIMEOUT_MS = 20_000;

let offscreenPort = null;
let offscreenCreation = null;
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
  if (message?.type !== CONTENT_MESSAGE_TYPE) {
    return false;
  }
  void handleContentRequest(message, sender).then(sendResponse);
  return true;
});

async function handleContentRequest(message, sender) {
  if (
    !isTrustedContentSender(sender) ||
    !REQUEST_ID_PATTERN.test(String(message.requestId ?? ""))
  ) {
    return { ok: false, reason: "rejected" };
  }

  let captchaUrl;
  try {
    captchaUrl = validateCaptchaUrl(message.imageUrl);
  } catch {
    return { ok: false, reason: "rejected" };
  }

  let imageBase64;
  try {
    const imageBytes = await fetchCaptchaBytes(captchaUrl);
    imageBase64 = bytesToBase64(imageBytes);
  } catch {
    return { ok: false, reason: "temporary-failure" };
  }

  try {
    const result = await sendOCRJob(imageBase64);
    if (result.ok && ANSWER_PATTERN.test(result.answer)) {
      return { ok: true, answer: result.answer };
    }
    return {
      ok: false,
      reason: result.reason === "uncertain" ? "uncertain" : "unreadable",
    };
  } catch {
    // The fetch above creates the newest challenge for this flag. If local
    // processing then fails, the page must refresh instead of showing a stale
    // image that no longer corresponds to the server-side answer.
    return { ok: false, reason: "unreadable" };
  }
}

function isTrustedContentSender(sender) {
  if (
    sender?.id !== chrome.runtime.id ||
    sender.frameId !== 0 ||
    typeof sender.url !== "string"
  ) {
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

async function sendOCRJob(imageBase64) {
  const port = await ensureOffscreenPort();
  const id = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingJobs.delete(id);
      reject(new Error("OCR timed out"));
    }, OCR_TIMEOUT_MS);
    pendingJobs.set(id, { resolve, reject, timeout });
    try {
      port.postMessage({ type: "solve", id, imageBase64 });
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
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["BLOBS"],
      justification: "Decode local captcha image bytes and host the bundled OCR worker.",
    });
  })();
  try {
    await offscreenCreation;
  } finally {
    offscreenCreation = null;
  }
}

async function hasOffscreenDocument() {
  if (typeof chrome.runtime.getContexts === "function") {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [OFFSCREEN_URL],
    });
    return contexts.length > 0;
  }
  const contexts = await clients.matchAll({
    includeUncontrolled: true,
    type: "window",
  });
  return contexts.some((context) => context.url === OFFSCREEN_URL);
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
