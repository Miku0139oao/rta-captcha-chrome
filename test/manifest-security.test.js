import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
  await readFile(path.join(projectRoot, "manifest.json"), "utf8"),
);

test("manifest is MV3 with the minimum permission surface", () => {
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, ["offscreen"]);
  assert.deepEqual(manifest.host_permissions, [
    "https://sso.rta-os.com/*",
    "https://mansso.rta-os.com/*",
  ]);
  assert.equal(manifest.optional_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.web_accessible_resources, undefined);
  assert.deepEqual(manifest.background, {
    service_worker: "background.js",
    type: "module",
  });
});

test("content script is limited to RTA login hosts, including SSO iframes", () => {
  assert.equal(manifest.content_scripts.length, 1);
  assert.deepEqual(manifest.content_scripts[0].matches, [
    "https://sso.rta-os.com/*",
    "https://mansso.rta-os.com/*",
    "https://partner.rta-os.com/*",
  ]);
  assert.equal(manifest.content_scripts[0].all_frames, true);
  assert.equal(manifest.content_scripts[0].match_about_blank, false);
  assert.ok(!JSON.stringify(manifest).includes("<all_urls>"));
  assert.ok(!JSON.stringify(manifest).includes("http://"));
});

test("extension CSP forbids inline, evaluated, remote, and object code", () => {
  const csp = manifest.content_security_policy.extension_pages;
  assert.match(csp, /script-src 'self'/);
  assert.match(csp, /worker-src 'self'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /base-uri 'none'/);
  assert.doesNotMatch(csp, /unsafe-eval|unsafe-inline|https?:/);
});

test("all executable code is packaged locally and does not use eval", async () => {
  const files = await collectFiles(projectRoot);
  const executableFiles = files.filter((file) => /\.(?:js|mjs|html)$/.test(file));
  for (const file of executableFiles) {
    const source = await readFile(file, "utf8");
    const relative = path.relative(projectRoot, file);
    assert.doesNotMatch(source, /\beval\s*\(/, relative);
    assert.doesNotMatch(source, /\bnew\s+Function\s*\(/, relative);
    assert.doesNotMatch(
      source,
      /(?:<script[^>]+src|\bimport(?:Scripts)?\s*\()[^\n]*https?:/i,
      relative,
    );
  }
});

test("architecture keeps OCR out of the page and fills only on demand", async () => {
  const [content, background, offscreen, pageCore] = await Promise.all([
    readFile(path.join(projectRoot, "content.js"), "utf8"),
    readFile(path.join(projectRoot, "background.js"), "utf8"),
    readFile(path.join(projectRoot, "offscreen.js"), "utf8"),
    readFile(path.join(projectRoot, "lib", "page-core.js"), "utf8"),
  ]);
  assert.match(pageCore, /img#verifyCodeMsg/);
  assert.match(pageCore, /input#verifyCode\[name=/);
  assert.match(pageCore, /dblclick/);
  assert.match(pageCore, /prefetch/);
  assert.doesNotMatch(pageCore, /querySelector(?:All)?\([^)]*(?:account|password)/i);
  assert.doesNotMatch(pageCore, /EmbeddedOCRSolver|templates\.generated/);
  assert.doesNotMatch(content, /EmbeddedOCRSolver|templates\.generated/);
  assert.doesNotMatch(content, /\.submit\s*\(/i);
  assert.match(background, /chrome\.offscreen\.createDocument/);
  assert.match(background, /closeDocument/);
  assert.match(background, /parsePixelJob/);
  assert.match(offscreen, /new Worker\(/);
  assert.match(offscreen, /ocr\/worker\.js/);
  assert.match(offscreen, /connectToBackground\(\);/);
  assert.doesNotMatch(offscreen, /connectToBackground\(\);\s*ensureWorker\(\);/);
});

test("the extension never rewrites the page's captcha image", async () => {
  const [content, pageCore] = await Promise.all([
    readFile(path.join(projectRoot, "content.js"), "utf8"),
    readFile(path.join(projectRoot, "lib", "page-core.js"), "utf8"),
  ]);
  // The old overlay path replaced image.src with a blob URL, which leaked the
  // object URL and left a stale `rtaOcrOriginal` behind that broke token
  // comparison after the site refreshed the challenge.
  for (const source of [content, pageCore]) {
    assert.doesNotMatch(source, /createObjectURL/);
    assert.doesNotMatch(source, /image\.src\s*=/);
    assert.doesNotMatch(source, /rtaOcrOriginal/);
  }
});

test("the page refuses to reuse an answer past the challenge lifetime", async () => {
  const pageCore = await readFile(
    path.join(projectRoot, "lib", "page-core.js"),
    "utf8",
  );
  // RTA drops a challenge after about a minute, so a stale answer must never be
  // filled. The cache carries a solve timestamp and the same freshness gate is
  // applied to the cached answer and to the on-screen challenge.
  assert.match(pageCore, /CAPTCHA_TTL_MS\s*=\s*50_000/);
  assert.match(pageCore, /solvedAt/);
  assert.match(pageCore, /isChallengeFresh/);
  assert.match(pageCore, /refreshCaptchaImage/);
});

test("filling always overwrites the captcha input", async () => {
  const pageCore = await readFile(
    path.join(projectRoot, "lib", "page-core.js"),
    "utf8",
  );
  assert.match(pageCore, /Always overwrite/);
});

test("credential and broad browsing APIs are not requested or called", async () => {
  const forbiddenPermissions = [
    "activeTab",
    "cookies",
    "declarativeNetRequest",
    "history",
    "scripting",
    "storage",
    "tabs",
    "webNavigation",
    "webRequest",
  ];
  for (const permission of forbiddenPermissions) {
    assert.ok(!manifest.permissions.includes(permission), permission);
  }
  const extensionSources = await Promise.all(
    ["background.js", "offscreen.js", "lib/page-core.js"].map((file) =>
      readFile(path.join(projectRoot, file), "utf8"),
    ),
  );
  assert.doesNotMatch(extensionSources.join("\n"), /chrome\.(?:cookies|history)\b/);
});

async function collectFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if ([".git", ".tmp", "coverage", "node_modules", "tampermonkey"].includes(entry.name)) {
      continue;
    }
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(target)));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}
