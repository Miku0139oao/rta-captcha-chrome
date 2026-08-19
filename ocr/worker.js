import {
  EmbeddedOCRSolver,
  OCRInputError,
  OCRUncertainError,
} from "./solver.js";

const MAX_ENCODED_LENGTH = 6 * 1024 * 1024;
const ANSWER_PATTERN = /^[0-9a-f]{5}$/;
let solver;

self.addEventListener("message", (event) => {
  void handleMessage(event.data);
});

async function handleMessage(message) {
  const id = isJobId(message?.id) ? message.id : "invalid";
  if (
    message?.type !== "solve" ||
    !isJobId(message.id) ||
    typeof message.imageBase64 !== "string" ||
    message.imageBase64.length === 0 ||
    message.imageBase64.length > MAX_ENCODED_LENGTH
  ) {
    self.postMessage({ id, ok: false, reason: "invalid-request" });
    return;
  }

  try {
    const image = await decodeImage(message.imageBase64);
    solver ??= new EmbeddedOCRSolver();
    const answer = solver.solve(image);
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
  try {
    bitmap = await createImageBitmap(new Blob([bytes]));
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
