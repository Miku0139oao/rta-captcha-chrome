export const SSO_ORIGIN = "https://sso.rta-os.com";
export const CAPTCHA_ORIGIN = "https://mansso.rta-os.com";
export const CAPTCHA_PATH = "/getVerifyCodeImg";
export const CAPTCHA_FLAG_PATTERN = /^[0-9a-f]{32}$/i;
export const REQUEST_ID_PATTERN = /^[a-f0-9-]{16,64}$/;
export const ANSWER_PATTERN = /^[0-9a-f]{5}$/;

export function isTrustedSSOPageUrl(value) {
  if (typeof value !== "string" || value.length > 4096) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.origin === SSO_ORIGIN &&
      url.username === "" &&
      url.password === ""
    );
  } catch {
    return false;
  }
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
