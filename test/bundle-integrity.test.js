import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));

// Content scripts are classic scripts. An ESM `import` is a syntax error, and
// Chrome drops the whole file without surfacing anything the extension can see:
// the extension then simply does nothing. This regressed once already, so every
// declared content script is compiled as a classic script here.
function assertClassicScript(source, label) {
  assert.doesNotThrow(() => new vm.Script(source, { filename: label }), label);
  assert.doesNotMatch(source, /^\s*(?:import|export)\s/m, `${label} must not use ESM syntax`);
}

test("every declared content script is a loadable classic script", async () => {
  const scripts = manifest.content_scripts.flatMap((entry) => entry.js);
  assert.ok(scripts.length > 0);
  for (const relative of scripts) {
    const source = await readFile(path.join(root, relative), "utf8");
    assertClassicScript(source, relative);
  }
});

test("the content script actually contains the page behaviour", async () => {
  // A syntactically valid but empty bundle would pass the parse check above, so
  // assert the shared logic really made it in.
  const source = await readFile(path.join(root, "content.js"), "utf8");
  for (const marker of [
    "createCaptchaPage",
    "img#verifyCodeMsg",
    "input-verify_code",
    "refreshCaptchaImage",
    "RTA_CAPTCHA_SOLVE",
  ]) {
    assert.ok(source.includes(marker), marker);
  }
  assert.ok(!source.includes('import {'), "the bundle must not keep import statements");
});

test("the committed content script matches its sources", async () => {
  // Same guarantee as the userscript: a source edit that was not rebuilt would
  // otherwise ship an extension with stale behaviour.
  const { execFileSync } = await import("node:child_process");
  assert.doesNotThrow(() =>
    execFileSync(process.execPath, [path.join(root, "scripts", "build-content.mjs"), "--check"], {
      stdio: "pipe",
    }),
  );
});

test("the userscript is a loadable classic script", async () => {
  const source = await readFile(
    path.join(root, "tampermonkey", "rta-captcha.user.js"),
    "utf8",
  );
  const body = source.replace(/^\/\/ ==UserScript==[\s\S]*?==\/UserScript==\n/, "");
  assertClassicScript(body, "tampermonkey/rta-captcha.user.js");
});
