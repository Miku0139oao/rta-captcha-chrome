import { readFile } from "node:fs/promises";
import path from "node:path";

// Single source of truth for the shipped version. manifest.json is authoritative
// because the Chrome Web Store reads it; every generated artefact (userscript
// header, package.json) is checked against it instead of keeping its own copy.
export async function readVersion(root) {
  const manifest = JSON.parse(
    await readFile(path.join(root, "manifest.json"), "utf8"),
  );
  if (typeof manifest.version !== "string" || manifest.version === "") {
    throw new Error("manifest.json is missing a version");
  }
  return manifest.version;
}
