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
  assert.doesNotMatch(userscript, /@grant\s+none/);
  assert.match(userscript, /class EmbeddedOCRSolver/);
  assert.match(userscript, /dblclick/);
  assert.match(userscript, /WORKER_SOURCE/);
  assert.match(userscript, /createCaptchaPage/);
  assert.match(userscript, /releaseEngine/);
  assert.match(userscript, /ensureCaptchaCors/);
  assert.match(userscript, /@run-at\s+document-start/);
  assert.match(userscript, /use-credentials/);
  assert.doesNotMatch(userscript, /showPreview/);
  assert.doesNotMatch(userscript, /fetchCaptchaBytes/);
  assert.doesNotMatch(userscript, /showFetchedImage/);
  assert.match(userscript, /img#verifyCodeMsg/);
  assert.match(userscript, /input-verify_code/);
  assert.doesNotMatch(userscript, /^import /m);
  assert.doesNotMatch(userscript, /^export /m);
  assert.doesNotMatch(userscript, /chrome\.runtime/);
});

test("userscript header version is generated from manifest.json", async () => {
  const manifest = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  const packageJson = JSON.parse(
    await readFile(path.join(root, "package.json"), "utf8"),
  );
  assert.match(userscript, new RegExp(`@version\\s+${manifest.version}`));
  assert.equal(packageJson.version, manifest.version);
});

test("userscript bundles the shared page logic instead of a private copy", () => {
  // Every behaviour that used to be duplicated per platform now comes from
  // lib/page-core.js, so the two builds cannot drift apart again.
  for (const marker of [
    "CAPTCHA_TTL_MS",
    "isChallengeFresh",
    "refreshCaptchaImage",
    "fillCaptchaInput",
    "createCaptchaPage",
  ]) {
    assert.match(userscript, new RegExp(marker), marker);
  }
  // Refreshing is allowed now (the challenge expires after a minute), but it
  // must go through page-core's guarded refresh rather than an ad hoc click.
  assert.match(userscript, /refreshCaptchaImage/);
  assert.equal(userscript.match(/image\.click\(\)/g)?.length, 1);
});
