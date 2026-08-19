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

const files = await collectJavaScript(projectRoot);
for (const file of files) {
  execFileSync(process.execPath, ["--check", file], { stdio: "pipe" });
}
console.log(`Syntax checked ${files.length} JavaScript files.`);
