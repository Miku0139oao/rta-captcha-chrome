import {
  EmbeddedOCRSolver,
  OCRInputError,
  OCRUncertainError,
} from "./solver.js";
import { parsePixelJob } from "../lib/protocol.js";

const MAX_ENCODED_LENGTH = 6 * 1024 * 1024;
const ANSWER_PATTERN = /^[0-9a-f]{5}$/;
let solver;

self.addEventListener("message", (event) => {
  void handleMessage(event.data);
});

async function handleMessage(message) {
  const id = isJobId(message?.id) ? message.id : "invalid";
  if (message?.type === "warmup" && isJobId(message.id)) {
    getSolver();
    self.postMessage({ id, ok: true, warmed: true });
    return;
  }
  if (message?.type !== "solve" || !isJobId(message.id)) {
    self.postMessage({ id, ok: false, reason: "invalid-request" });
    return;
  }

  try {
    const image = await resolveImage(message);
    const answer = getSolver().solve(image);
    if (!ANSWER_PATTERN.test(answer)) {
      throw new OCRInputError("OCR returned an invalid answer", "invalid-answer");
    }
    self.postMessage({ id, ok: true, answer });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      reason: classifyError(error),
    });
  }
}

async function resolveImage(message) {
  const pixels = parsePixelJob(message);
  if (pixels) {
    return {
      width: pixels.width,
      height: pixels.height,
      data: new Uint8ClampedArray(pixels.buffer),
    };
  }
  if (
    typeof message.imageBase64 === "string" &&
    message.imageBase64.length > 0 &&
    message.imageBase64.length <= MAX_ENCODED_LENGTH
  ) {
    return decodeImage(message.imageBase64);
  }
  throw new OCRInputError("Invalid OCR request", "invalid-request");
}

function getSolver() {
  solver ??= new EmbeddedOCRSolver();
  return solver;
}

async function decodeImage(imageBase64) {
  let binary;
  try {
    binary = atob(imageBase64);
  } catch {
    throw new OCRInputError("Malformed base64 image", "invalid-image");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  let bitmap;
  const rawDecodeOptions = {
    premultiplyAlpha: "none",
    colorSpaceConversion: "none",
  };
  try {
    try {
      bitmap = await createImageBitmap(new Blob([bytes]), rawDecodeOptions);
    } catch {
      bitmap = await createImageBitmap(new Blob([bytes]));
    }
  } catch {
    throw new OCRInputError("Cannot decode captcha image", "decode-failed");
  }
  try {
    if (bitmap.width * bitmap.height > 2_000_000) {
      throw new OCRInputError("Captcha image dimensions are too large", "too-large");
    }
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext("2d", {
      alpha: false,
      colorSpace: "srgb",
      willReadFrequently: true,
    });
    if (!context) {
      throw new OCRInputError("Cannot create image context", "decode-failed");
    }
    context.drawImage(bitmap, 0, 0);
    return context.getImageData(0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

function classifyError(error) {
  if (error instanceof OCRUncertainError) {
    return "uncertain";
  }
  if (error instanceof OCRInputError) {
    return error.code;
  }
  return "ocr-failed";
}

function isJobId(value) {
  return typeof value === "string" && /^[a-f0-9-]{16,64}$/.test(value);
}
