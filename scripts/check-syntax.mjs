import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const excludedDirectories = new Set([".git", ".tmp", "coverage", "node_modules"]);

async function collectJavaScript(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !excludedDirectories.has(entry.name)) {
      files.push(...(await collectJavaScript(path.join(directory, entry.name))));
    } else if (entry.isFile() && /\.(?:js|mjs)$/.test(entry.name)) {
      files.push(path.join(directory, entry.name));
    }
  }
  return files;
}

// `node --check` parses each file in isolation. That catches a syntax error but
// not a missing or misspelt import, because those only surface when the module
// graph is actually linked. Link every ESM entry point for real as well.
const MODULE_ENTRY_POINTS = [
  "ocr/solver.js",
  "lib/protocol.js",
  "lib/glyph.js",
  "lib/page-core.js",
];

const files = await collectJavaScript(projectRoot);
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}

for (const entry of MODULE_ENTRY_POINTS) {
  const specifier = `file:///${path
    .join(projectRoot, entry)
    .split(path.sep)
    .join("/")}`;
  // Importing (not merely parsing) fails on a bad named import, a typo in a
  // relative path, or a top-level throw.
  const probe = `
    try {
      await import(${JSON.stringify(specifier)});
    } catch (error) {
      console.error(${JSON.stringify(entry)} + ": " + (error && error.stack ? error.stack : error));
      process.exit(1);
    }
  `;
  execFileSync(process.execPath, ["--input-type=module", "--eval", probe], {
    stdio: ["ignore", "ignore", "pipe"],
  });
}

// The extension-only modules touch \`chrome\` at top level, which Node does not
// provide. They are covered by test/manifest-security.test.js instead.
console.log(
  `Syntax checked ${files.length} files; linked ${MODULE_ENTRY_POINTS.length} modules.`,
);
