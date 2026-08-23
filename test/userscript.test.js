import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const userscript = await readFile(
  path.join(root, "tampermonkey", "rta-captcha.user.js"),
  "utf8",
);

test("userscript has a Tampermonkey header and local OCR solver", () => {
  assert.match(userscript, /^\/\/ ==UserScript==/m);
  assert.match(userscript, /@match\s+https:\/\/\*\.rta-os\.com\/\*/);
  assert.match(userscript, /@grant\s+GM_xmlhttpRequest/);
  assert.doesNotMatch(userscript, /@grant\s+none/);
  assert.match(userscript, /class EmbeddedOCRSolver/);
  assert.match(userscript, /dblclick/);
  assert.match(userscript, /WORKER_SOURCE/);
  assert.match(userscript, /prefetchCurrentCaptcha/);
  assert.match(userscript, /releaseEngine/);
  assert.match(userscript, /onLoginSurface/);
  assert.match(userscript, /@run-at\s+document-start/);
  assert.match(userscript, /use-credentials/);
  assert.match(userscript, /ensureCaptchaCors/);
  assert.doesNotMatch(userscript, /showPreview/);
  assert.doesNotMatch(userscript, /fetchCaptchaBytes/);
  assert.doesNotMatch(userscript, /showFetchedImage/);
  assert.doesNotMatch(userscript, /image\.click\(/);
  assert.match(userscript, /img#verifyCodeMsg/);
  assert.match(userscript, /input-verify_code/);
  assert.doesNotMatch(userscript, /^import /m);
  assert.doesNotMatch(userscript, /^export /m);
  assert.doesNotMatch(userscript, /chrome\.runtime/);
});
