import assert from "node:assert/strict";
import test from "node:test";

// page-core reaches for DOM globals at call time, not at import time, so the
// pure parts of it can be exercised in Node to lock in the one-minute lifetime
// rules without a browser.
import {
  ANSWER_PATTERN,
  CAPTCHA_TTL_MS,
  DEFAULT_HINTS,
} from "../lib/page-core.js";

test("the answer contract stays five lowercase hex characters", () => {
  for (const valid of ["0be7f", "e2c63", "00000", "fffff"]) {
    assert.equal(ANSWER_PATTERN.test(valid), true, valid);
  }
  for (const invalid of ["", "0BE7F", "0be7", "0be7ff", "0be7g", " 0be7f"]) {
    assert.equal(ANSWER_PATTERN.test(invalid), false, invalid);
  }
});

test("the challenge lifetime stays safely under RTA's one minute", () => {
  // The server drops a challenge after about 60 s. Anything at or above that
  // would let a stale answer be filled into a form the server already rejected.
  assert.ok(CAPTCHA_TTL_MS > 0);
  assert.ok(CAPTCHA_TTL_MS < 60_000, `ttl is ${CAPTCHA_TTL_MS}`);
  // And it must still be long enough to cover an OCR pass plus the click.
  assert.ok(CAPTCHA_TTL_MS >= 30_000, `ttl is ${CAPTCHA_TTL_MS}`);
});

test("every hint message is present and user-facing", () => {
  for (const key of ["ready", "busy", "refreshing", "done", "failed", "empty"]) {
    assert.equal(typeof DEFAULT_HINTS[key], "string", key);
    assert.ok(DEFAULT_HINTS[key].length > 0, key);
  }
  // Hints go into an input title, so they must not leak internals.
  const combined = Object.values(DEFAULT_HINTS).join(" ");
  for (const leak of ["chrome.", "offscreen", "worker", "jobId", "saleId"]) {
    assert.ok(!combined.includes(leak), leak);
  }
});
