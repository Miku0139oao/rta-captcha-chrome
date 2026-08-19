import assert from "node:assert/strict";
import test from "node:test";

import {
  hasImageSignature,
  isTrustedSSOPageUrl,
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

test("SSO sender URL validator requires the exact HTTPS origin", () => {
  assert.equal(isTrustedSSOPageUrl("https://sso.rta-os.com/"), true);
  assert.equal(
    isTrustedSSOPageUrl("https://sso.rta-os.com/#index/sso/login"),
    true,
  );
  assert.equal(isTrustedSSOPageUrl("http://sso.rta-os.com/"), false);
  assert.equal(isTrustedSSOPageUrl("https://sso.rta-os.com.evil.test/"), false);
  assert.equal(isTrustedSSOPageUrl("https://user@sso.rta-os.com/"), false);
  assert.equal(isTrustedSSOPageUrl("not a URL"), false);
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
