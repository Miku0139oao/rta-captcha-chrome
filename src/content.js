// Content script for the MV3 extension.
//
// Everything about finding the captcha, its lifetime, refreshing, and filling is
// in lib/page-core.js, shared with the Tampermonkey build. This file only wires
// the extension transport: read the challenge through the service worker, and
// release the offscreen document when the user leaves the login page.

import { createCaptchaPage } from "../lib/page-core.js";
import {
  ANSWER_PATTERN,
  FILL_MESSAGE_TYPE,
  MESSAGE_TYPE,
  RELEASE_MESSAGE_TYPE,
  WARMUP_MESSAGE_TYPE,
  challengeUrl,
} from "../lib/protocol.js";

const page = createCaptchaPage({
  recognize: recognizeCaptcha,
  warmup: warmUpEngine,
  release: releaseEngine,
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== FILL_MESSAGE_TYPE) {
    return false;
  }
  void page.fillNow().then(() => sendResponse({ ok: true }));
  return true;
});

page.install();

async function warmUpEngine() {
  await chrome.runtime.sendMessage({ type: WARMUP_MESSAGE_TYPE });
}

function releaseEngine() {
  chrome.runtime
    .sendMessage({ type: RELEASE_MESSAGE_TYPE })
    .catch(() => undefined);
}

async function recognizeCaptcha(image) {
  // Try the visible pixels first. That is free, needs no network round trip, and
  // is the only way to be certain the answer matches what the user sees. It is
  // also the path that works when the site serves the image with CORS headers.
  const pixels = readCanvasPixels(image);
  if (pixels) {
    const response = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPE,
      requestId: crypto.randomUUID(),
      width: pixels.width,
      height: pixels.height,
      buffer: pixels.data.buffer,
    });
    return readAnswer(response);
  }

  // The canvas is tainted, so the site serves the image without CORS headers.
  // Ask the service worker to fetch the same challenge URL; page-core has already
  // pinned the visible image and re-checks its token before anything is filled.
  const imageUrl = challengeUrl(image);
  if (!imageUrl) {
    throw new Error("captcha pixels are not readable");
  }
  const response = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPE,
    requestId: crypto.randomUUID(),
    imageUrl,
  });
  return readAnswer(response);
}

function readAnswer(response) {
  if (
    response?.ok === true &&
    ANSWER_PATTERN.test(String(response.answer ?? ""))
  ) {
    return response.answer;
  }
  const error = new Error(response?.reason || "ocr failed");
  error.reason = response?.reason;
  throw error;
}

function readCanvasPixels(image) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  if (width < 8 || height < 16) {
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) {
    return null;
  }
  try {
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, width, height);
  } catch {
    // Tainted canvas: the image was served without CORS headers.
    return null;
  }
}
