// Offscreen document: the only place the OCR worker runs. The page cannot reach
// this port; the service worker verifies the sender of every message.

import {
  ANSWER_PATTERN,
  OFFSCREEN_IDLE_MESSAGE_TYPE,
  OFFSCREEN_PORT_NAME,
  REQUEST_ID_PATTERN,
} from "./lib/protocol.js";

const IDLE_CLOSE_MS = 25_000;
const MAX_ENCODED_LENGTH = 6 * 1024 * 1024;

let backgroundPort = null;
let ocrWorker = null;
let reconnectTimer = null;
let idleCloseTimer = null;
let shuttingDown = false;
const activeJobs = new Set();

connectToBackground();

function connectToBackground() {
  clearTimeout(reconnectTimer);
  const port = chrome.runtime.connect({ name: OFFSCREEN_PORT_NAME });
  backgroundPort = port;
  port.onMessage.addListener((message) => {
    handleBackgroundMessage(message, port);
  });
  port.onDisconnect.addListener(() => {
    if (backgroundPort === port) {
      backgroundPort = null;
    }
    activeJobs.clear();
    resetWorker();
    if (!shuttingDown) {
      reconnectTimer = setTimeout(connectToBackground, 250);
    }
  });
}

function scheduleIdleClose() {
  clearTimeout(idleCloseTimer);
  idleCloseTimer = setTimeout(() => {
    if (activeJobs.size > 0 || !backgroundPort) {
      return;
    }
    shuttingDown = true;
    // Wakes the service worker so it can close this document.
    chrome.runtime
      .sendMessage({ type: OFFSCREEN_IDLE_MESSAGE_TYPE })
      .catch(() => undefined);
  }, IDLE_CLOSE_MS);
}

function handleBackgroundMessage(message, sourcePort) {
  if (
    sourcePort !== backgroundPort ||
    !REQUEST_ID_PATTERN.test(String(message?.id ?? "")) ||
    activeJobs.has(message.id)
  ) {
    return;
  }

  if (message.type === "warmup") {
    activeJobs.add(message.id);
    ensureWorker().postMessage({ type: "warmup", id: message.id });
    return;
  }

  if (message.type !== "solve") {
    return;
  }

  const pixelJob = isPixelMessage(message);
  const encodedJob =
    typeof message.imageBase64 === "string" &&
    message.imageBase64.length > 0 &&
    message.imageBase64.length <= MAX_ENCODED_LENGTH;

  if (!pixelJob && !encodedJob) {
    return;
  }

  activeJobs.add(message.id);
  const worker = ensureWorker();
  if (pixelJob) {
    worker.postMessage(
      {
        type: "solve",
        id: message.id,
        width: message.width,
        height: message.height,
        buffer: message.buffer,
      },
      message.buffer instanceof ArrayBuffer ? [message.buffer] : [],
    );
    return;
  }
  worker.postMessage({
    type: "solve",
    id: message.id,
    imageBase64: message.imageBase64,
  });
}

function isPixelMessage(message) {
  return (
    Number.isInteger(message.width) &&
    Number.isInteger(message.height) &&
    message.buffer instanceof ArrayBuffer &&
    message.buffer.byteLength === message.width * message.height * 4
  );
}

function ensureWorker() {
  if (ocrWorker) {
    return ocrWorker;
  }
  const worker = new Worker(chrome.runtime.getURL("ocr/worker.js"), {
    type: "module",
    name: "rta-embedded-ocr",
  });
  worker.addEventListener("message", (event) => {
    const message = event.data;
    if (
      !REQUEST_ID_PATTERN.test(String(message?.id ?? "")) ||
      !activeJobs.has(message.id)
    ) {
      return;
    }
    activeJobs.delete(message.id);
    if (backgroundPort) {
      backgroundPort.postMessage(sanitizeWorkerResponse(message));
    }
    scheduleIdleClose();
  });
  worker.addEventListener("error", () => {
    for (const id of activeJobs) {
      backgroundPort?.postMessage({ id, ok: false, reason: "worker-failed" });
    }
    activeJobs.clear();
    resetWorker();
    scheduleIdleClose();
  });
  ocrWorker = worker;
  return worker;
}

function sanitizeWorkerResponse(message) {
  if (message.ok === true && message.warmed === true) {
    return { id: message.id, ok: true, warmed: true };
  }
  if (message.ok === true && ANSWER_PATTERN.test(String(message.answer ?? ""))) {
    return { id: message.id, ok: true, answer: message.answer };
  }
  return {
    id: message.id,
    ok: false,
    reason: message.reason === "uncertain" ? "uncertain" : "ocr-failed",
  };
}

function resetWorker() {
  ocrWorker?.terminate();
  ocrWorker = null;
}
