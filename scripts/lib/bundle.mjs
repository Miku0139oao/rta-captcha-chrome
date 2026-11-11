import { readFile } from "node:fs/promises";
import path from "node:path";

// Reads a source file for embedding. Building on Windows (core.autocrlf=true) must
// produce the same bytes as building on Linux CI, otherwise every rebuild rewrites
// the committed artefact. Normalise before embedding anything.
export async function readSource(root, ...parts) {
  const source = await readFile(path.join(root, ...parts), "utf8");
  return source.split("\r\n").join("\n");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Drops every ESM import block for the given specifiers and removes `export`
// keywords, leaving plain top-level declarations that a classic script can
// concatenate. Anything left over is a build error rather than a silent runtime
// failure, so a newly added dependency cannot slip through unnoticed.
export function bundleModule(source, sourceName, specifiers) {
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
  // Re-export statements have no equivalent in a concatenated bundle; the names
  // are already in scope. Drop them before stripping the `export` keyword, which
  // would otherwise leave a bare block statement behind.
  bundled = bundled.replace(/^export\s*\{[^}]*\};?[ \t]*\n?/gm, "");
  bundled = bundled.replace(/^export\s+default\s+/gm, "");
  bundled = bundled.replace(/^export /gm, "");
  if (/^\s*import\s/m.test(bundled) || /^\s*export\s/m.test(bundled)) {
    throw new Error(`${sourceName} still contains ESM import/export after bundling`);
  }
  return bundled;
}
