import assert from "node:assert/strict";
import test from "node:test";

import {
  MAX_IMAGE_BYTES,
  hasImageSignature,
  isTrustedSSOPageUrl,
  parseDeclaredImageLength,
  parsePixelJob,
  validateCaptchaUrl,
} from "../lib/protocol.js";

const flag = "0123456789ABCDEF0123456789ABCDEF";
const validCaptchaUrl =
  `https://mansso.rta-os.com/getVerifyCodeImg?verifyCodeFlag=${flag}`;

test("captcha URL validator accepts only the production endpoint contract", () => {
  assert.equal(validateCaptchaUrl(validCaptchaUrl), validCaptchaUrl);
  for (const rejected of [
    validCaptchaUrl.replace("https:", "http:"),
    validCaptchaUrl.replace("mansso.rta-os.com", "mansso.rta-os.com.evil.test"),
    validCaptchaUrl.replace("mansso.rta-os.com", "user@mansso.rta-os.com"),
    validCaptchaUrl.replace("getVerifyCodeImg", "doLogin"),
    `${validCaptchaUrl}#fragment`,
    `${validCaptchaUrl}&next=https://evil.test/`,
    `${validCaptchaUrl}&verifyCodeFlag=${flag}`,
    validCaptchaUrl.replace(flag, flag.slice(1)),
    validCaptchaUrl.replace("verifyCodeFlag", "flag"),
    "not a URL",
  ]) {
    assert.throws(() => validateCaptchaUrl(rejected), rejected);
  }
});

test("SSO sender URL validator allows RTA login hosts only", () => {
  assert.equal(isTrustedSSOPageUrl("https://sso.rta-os.com/"), true);
  assert.equal(
    isTrustedSSOPageUrl("https://sso.rta-os.com/#index/sso/login"),
    true,
  );
  assert.equal(isTrustedSSOPageUrl("https://mansso.rta-os.com/login"), true);
  assert.equal(isTrustedSSOPageUrl("https://partner.rta-os.com/"), true);
  assert.equal(isTrustedSSOPageUrl("http://sso.rta-os.com/"), false);
  assert.equal(isTrustedSSOPageUrl("https://sso.rta-os.com.evil.test/"), false);
  assert.equal(isTrustedSSOPageUrl("https://user@sso.rta-os.com/"), false);
  assert.equal(isTrustedSSOPageUrl("https://shop.rta-os.com/"), false);
  assert.equal(isTrustedSSOPageUrl("not a URL"), false);
});

test("pixel job parser accepts only well-sized RGBA buffers", () => {
  const width = 20;
  const height = 16;
  const buffer = new ArrayBuffer(width * height * 4);
  assert.deepEqual(parsePixelJob({ width, height, buffer }), {
    width,
    height,
    buffer,
  });
  const fromView = parsePixelJob({ width, height, buffer: new Uint8Array(buffer) });
  assert.equal(fromView?.width, width);
  assert.equal(fromView?.height, height);
  assert.equal(fromView?.buffer.byteLength, buffer.byteLength);
  assert.equal(parsePixelJob({ width: 7, height, buffer }), null);
  assert.equal(parsePixelJob({ width, height: 8, buffer }), null);
  assert.equal(parsePixelJob({ width, height, buffer: new ArrayBuffer(4) }), null);
  assert.equal(parsePixelJob({ width: "20", height, buffer }), null);
});

test("image signature validator accepts supported local decode formats", () => {
  assert.equal(hasImageSignature(Uint8Array.of(0xff, 0xd8, 0xff)), true);
  assert.equal(
    hasImageSignature(
      Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    ),
    true,
  );
  assert.equal(
    hasImageSignature(Uint8Array.from(Buffer.from("GIF89a", "ascii"))),
    true,
  );
  assert.equal(
    hasImageSignature(
      Uint8Array.from(Buffer.from("RIFF0000WEBP", "ascii")),
    ),
    true,
  );
  assert.equal(hasImageSignature(Uint8Array.from([1, 2, 3, 4])), false);
  assert.equal(hasImageSignature("not bytes"), false);
});

test("a missing Content-Length is unknown, not an empty response", () => {
  // The captcha endpoint gzips and omits the header. Treating null as 0 rejected
  // every captcha fetch, which made the extension silently do nothing.
  assert.equal(parseDeclaredImageLength(null), null);
  assert.equal(parseDeclaredImageLength(undefined), null);
  assert.equal(parseDeclaredImageLength("3623"), 3623);
  assert.equal(parseDeclaredImageLength(String(MAX_IMAGE_BYTES)), MAX_IMAGE_BYTES);

  for (const rejected of ["0", "-1", "abc", "", String(MAX_IMAGE_BYTES + 1)]) {
    assert.throws(() => parseDeclaredImageLength(rejected), /length is invalid/, rejected);
  }
});
