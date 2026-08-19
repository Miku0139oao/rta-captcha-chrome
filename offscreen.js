const PORT_NAME = "rta-ocr-offscreen-v1";
const REQUEST_ID_PATTERN = /^[a-f0-9-]{16,64}$/;
const MAX_ENCODED_LENGTH = 6 * 1024 * 1024;

let backgroundPort = null;
let ocrWorker = null;
let reconnectTimer = null;
const activeJobs = new Set();

connectToBackground();
ensureWorker();

function connectToBackground() {
  clearTimeout(reconnectTimer);
  const port = chrome.runtime.connect({ name: PORT_NAME });
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
    reconnectTimer = setTimeout(connectToBackground, 250);
  });
}

function handleBackgroundMessage(message, sourcePort) {
  if (
    sourcePort !== backgroundPort ||
    message?.type !== "solve" ||
    !REQUEST_ID_PATTERN.test(String(message.id ?? "")) ||
    typeof message.imageBase64 !== "string" ||
    message.imageBase64.length === 0 ||
    message.imageBase64.length > MAX_ENCODED_LENGTH ||
    activeJobs.has(message.id)
  ) {
    return;
  }

  activeJobs.add(message.id);
  ensureWorker().postMessage({
    type: "solve",
    id: message.id,
    imageBase64: message.imageBase64,
  });
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
    if (!REQUEST_ID_PATTERN.test(String(message?.id ?? "")) || !activeJobs.has(message.id)) {
      return;
    }
    activeJobs.delete(message.id);
    if (backgroundPort) {
      backgroundPort.postMessage(sanitizeWorkerResponse(message));
    }
  });
  worker.addEventListener("error", () => {
    for (const id of activeJobs) {
      backgroundPort?.postMessage({ id, ok: false, reason: "worker-failed" });
    }
    activeJobs.clear();
    resetWorker();
  });
  ocrWorker = worker;
  return worker;
}

function sanitizeWorkerResponse(message) {
  if (message.ok === true && /^[0-9a-f]{5}$/.test(String(message.answer ?? ""))) {
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
