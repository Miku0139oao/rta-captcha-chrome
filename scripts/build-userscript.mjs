import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { bundleModule, readSource } from "./lib/bundle.mjs";
import { readVersion } from "./lib/version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const protocol = bundleModule(
  await readSource(root, "lib", "protocol.js"),
  "lib/protocol.js",
  [],
);
const templates = bundleModule(
  await readSource(root, "ocr", "templates.generated.js"),
  "ocr/templates.generated.js",
  [],
);
const glyph = bundleModule(
  await readSource(root, "lib", "glyph.js"),
  "lib/glyph.js",
  [],
);
const solver = bundleModule(
  await readSource(root, "ocr", "solver.js"),
  "ocr/solver.js",
  ["./templates.generated.js", "../lib/glyph.js"],
);
const pageCore = bundleModule(
  await readSource(root, "lib", "page-core.js"),
  "lib/page-core.js",
  ["./protocol.js"],
);
const trackerHosts = bundleModule(
  await readSource(root, "lib", "tracker-hosts.js"),
  "lib/tracker-hosts.js",
  [],
);
const page = await readSource(root, "tampermonkey", "page.js");

const ocrCore = `${templates}\n${glyph}\n${solver}`;
const workerTail = `
const solver = new EmbeddedOCRSolver();
self.addEventListener("message", (event) => {
  const message = event.data || {};
  try {
    const data = new Uint8ClampedArray(message.buffer);
    const answer = solver.solve({
      width: message.width,
      height: message.height,
      data,
    });
    self.postMessage({ id: message.id, ok: true, answer });
  } catch (error) {
    self.postMessage({
      id: message.id,
      ok: false,
      code: error && error.code,
      message: error && error.message ? error.message : String(error),
    });
  }
});
`;

const version = await readVersion(root);
const header = (await readSource(root, "tampermonkey", "header.js"))
  .trimEnd()
  .replace(/^\/\/ @version\s+.*$/m, `// @version      ${version}`);

const output = `${header}

(function () {
  "use strict";
  const OCR_CORE = ${JSON.stringify(ocrCore)};
  const WORKER_SOURCE = OCR_CORE + ${JSON.stringify(workerTail)};

${protocol}
${trackerHosts}
${pageCore}
${page}
})();
`;

const outDir = path.join(root, "tampermonkey");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, "rta-captcha.user.js");
const bundle = output.replace(/\r\n/g, "\n");

if (process.argv.includes("--check")) {
  // CI uses this to prove the committed bundle still matches its sources. The
  // worktree is left untouched so a stale artefact fails instead of being
  // silently rewritten by the check itself.
  const existing = await readFile(outFile, "utf8");
  if (existing !== bundle) {
    throw new Error(
      `${path.relative(root, outFile)} is out of date; run npm run build:userscript`,
    );
  }
  console.log(`${path.relative(root, outFile)} matches its sources (v${version}).`);
} else {
  await writeFile(outFile, bundle, "utf8");
  console.log(
    `Wrote ${path.relative(root, outFile)} (${bundle.length} bytes, v${version})`,
  );
}
