// Message and URL contract shared by the content script, the service worker,
// the offscreen document and the OCR worker. Keeping it in one module means a
// renamed message or a widened URL rule cannot silently desynchronise the four
// extension contexts.

export const SSO_ORIGIN = "https://sso.rta-os.com";
export const MANSSO_ORIGIN = "https://mansso.rta-os.com";
export const PARTNER_ORIGIN = "https://partner.rta-os.com";
export const CAPTCHA_ORIGIN = MANSSO_ORIGIN;
export const CAPTCHA_PATH = "/getVerifyCodeImg";
export const CAPTCHA_FLAG_PATTERN = /^[0-9a-f]{32}$/i;
export const REQUEST_ID_PATTERN = /^[a-f0-9-]{16,64}$/;
export const ANSWER_PATTERN = /^[0-9a-f]{5}$/;
export const TRUSTED_PAGE_ORIGINS = Object.freeze([
  SSO_ORIGIN,
  MANSSO_ORIGIN,
  PARTNER_ORIGIN,
]);
export const MAX_PIXEL_EDGE = 2048;
export const MAX_PIXEL_COUNT = 2_000_000;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export const MESSAGE_TYPE = "RTA_CAPTCHA_SOLVE";
export const WARMUP_MESSAGE_TYPE = "RTA_CAPTCHA_WARMUP";
export const RELEASE_MESSAGE_TYPE = "RTA_CAPTCHA_RELEASE";
export const FILL_MESSAGE_TYPE = "RTA_CAPTCHA_FILL";
export const OFFSCREEN_IDLE_MESSAGE_TYPE = "RTA_CAPTCHA_OFFSCREEN_IDLE";
export const OFFSCREEN_PORT_NAME = "rta-ocr-offscreen-v1";
export const OFFSCREEN_PAGE = "offscreen.html";

export function isTrustedSSOPageUrl(value) {
  if (typeof value !== "string" || value.length > 4096) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      TRUSTED_PAGE_ORIGINS.includes(url.origin) &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
}

export function asArrayBuffer(value) {
  if (value instanceof ArrayBuffer) {
    return value;
  }
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  return null;
}

export function parsePixelJob(message) {
  const width = message?.width;
  const height = message?.height;
  const buffer = asArrayBuffer(message?.buffer);
  if (!Number.isInteger(width) || !Number.isInteger(height) || !buffer) {
    return null;
  }
  if (
    width < 8 ||
    height < 16 ||
    width > MAX_PIXEL_EDGE ||
    height > MAX_PIXEL_EDGE ||
    width * height > MAX_PIXEL_COUNT ||
    buffer.byteLength !== width * height * 4
  ) {
    return null;
  }
  return { width, height, buffer };
}

export function validateCaptchaUrl(value) {
  if (typeof value !== "string" || value.length > 512) {
    throw new Error("Invalid captcha URL");
  }
  const url = new URL(value);
  const keys = [...url.searchParams.keys()];
  const flags = url.searchParams.getAll("verifyCodeFlag");
  if (
    url.origin !== CAPTCHA_ORIGIN ||
    url.pathname !== CAPTCHA_PATH ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    keys.length !== 1 ||
    keys[0] !== "verifyCodeFlag" ||
    flags.length !== 1 ||
    !CAPTCHA_FLAG_PATTERN.test(flags[0])
  ) {
    throw new Error("Untrusted captcha URL");
  }
  return url.href;
}

// Only a URL that resolves to the captcha endpoint of the login host is handed
// to the service worker. Anything else (a blob: URL from a previous overlay, a
// third-party image that happens to share a selector) returns "" and makes the
// caller fall back to reading on-screen pixels.
export function challengeUrl(image) {
  if (!image) {
    return "";
  }
  const candidate = image.currentSrc || image.src || "";
  if (!candidate) {
    return "";
  }
  try {
    return validateCaptchaUrl(candidate);
  } catch {
    return "";
  }
}

export function hasImageSignature(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    return false;
  }
  const jpeg =
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff;
  const png =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const gif =
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38;
  const webp =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  return jpeg || png || gif || webp;
}
