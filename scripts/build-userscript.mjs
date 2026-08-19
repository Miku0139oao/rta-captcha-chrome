import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const templates = (await readFile(path.join(root, "ocr", "templates.generated.js"), "utf8"))
  .replace(/^export /gm, "");

const solver = (await readFile(path.join(root, "ocr", "solver.js"), "utf8"))
  .replace(/import\s*\{[\s\S]*?\}\s*from\s*["']\.\/templates\.generated\.js["'];\s*/m, "")
  .replace(/^export /gm, "");

if (solver.includes("import ") || solver.includes("export ")) {
  throw new Error("solver.js still contains ESM import/export after rewrite");
}

const ocrCore = `${templates}\n${solver}`;
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

const header = (await readFile(path.join(root, "tampermonkey", "header.js"), "utf8")).trimEnd();
const page = await readFile(path.join(root, "tampermonkey", "page.js"), "utf8");

const output = `${header}

(function () {
  "use strict";
  const OCR_CORE = ${JSON.stringify(ocrCore)};
  const WORKER_SOURCE = OCR_CORE + ${JSON.stringify(workerTail)};

${page}
})();
`;

const outDir = path.join(root, "tampermonkey");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, "rta-captcha.user.js");
await writeFile(outFile, output);
console.log(`Wrote ${path.relative(root, outFile)} (${output.length} bytes)`);
