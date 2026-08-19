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

const header = (await readFile(path.join(root, "tampermonkey", "header.js"), "utf8")).trimEnd();
const page = await readFile(path.join(root, "tampermonkey", "page.js"), "utf8");

const output = `${header}

(function () {
  "use strict";

${templates}

${solver}

${page}
})();
`;

const outDir = path.join(root, "tampermonkey");
await mkdir(outDir, { recursive: true });
const outFile = path.join(outDir, "rta-captcha.user.js");
await writeFile(outFile, output);
console.log(`Wrote ${path.relative(root, outFile)} (${output.length} bytes)`);
