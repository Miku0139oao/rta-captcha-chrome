import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readVersion } from "./lib/version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function readSource(...parts) {
  const source = await readFile(path.join(root, ...parts), "utf8");
  // Building on Windows (core.autocrlf=true) must produce the same bytes as
  // building on Linux CI, otherwise every rebuild rewrites the committed
  // userscript. Normalise before embedding anything into the bundle.
  return source.split("\r\n").join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Drops every ESM import block for the given specifiers and removes the
// `export` keyword, leaving plain top-level declarations that the userscript can
// concatenate. Anything left over is a build error rather than a silent runtime
// failure, so a newly added dependency cannot slip through unnoticed.
function bundleModule(source, sourceName, specifiers) {
  let bundled = source;
  for (const specifier of specifiers) {
    bundled = bundled.replace(
      new RegExp(
        `import\\s*\\{[\\s\\S]*?\\}\\s*from\\s*["']${escapeRegExp(specifier)}["'];?[ \\t]*\\n?`,
        "g",
      ),
      "",
    );
  }
  bundled = bundled.replace(/^export /gm, "");
  if (/^\s*import\s/m.test(bundled) || /^\s*export\s/m.test(bundled)) {
    throw new Error(`${sourceName} still contains ESM import/export after bundling`);
  }
  return bundled;
}

const templates = bundleModule(
  await readSource("ocr", "templates.generated.js"),
  "ocr/templates.generated.js",
  [],
);
const glyph = bundleModule(await readSource("lib", "glyph.js"), "lib/glyph.js", []);
const solver = bundleModule(
  await readSource("ocr", "solver.js"),
  "ocr/solver.js",
  ["./templates.generated.js", "../lib/glyph.js"],
);
const pageCore = bundleModule(
  await readSource("lib", "page-core.js"),
  "lib/page-core.js",
  [],
);

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
const header = (await readSource("tampermonkey", "header.js"))
  .trimEnd()
  .replace(/^\/\/ @version\s+.*$/m, `// @version      ${version}`);
const page = await readSource("tampermonkey", "page.js");

const output = `${header}

(function () {
  "use strict";
  const OCR_CORE = ${JSON.stringify(ocrCore)};
  const WORKER_SOURCE = OCR_CORE + ${JSON.stringify(workerTail)};

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
