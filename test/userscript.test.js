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
  assert.match(userscript, /@connect\s+mansso\.rta-os\.com/);
  assert.match(userscript, /@connect\s+sso\.rta-os\.com/);
  assert.match(userscript, /@grant\s+GM_xmlhttpRequest/);
  assert.match(userscript, /class EmbeddedOCRSolver/);
  assert.match(userscript, /img#verifyCodeMsg/);
  assert.match(userscript, /input-verify_code/);
  assert.doesNotMatch(userscript, /^import /m);
  assert.doesNotMatch(userscript, /^export /m);
  assert.doesNotMatch(userscript, /chrome\.runtime/);
});
