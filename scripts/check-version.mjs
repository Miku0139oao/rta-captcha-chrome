// Fails when the committed artefacts disagree with manifest.json, or when the
// tag being released does not match it. Called by CI on every push, and by the
// release workflow before it packages a zip, so a release can never ship a
// userscript header, package.json, or zip whose version drifted.
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readVersion } from "./lib/version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = await readVersion(root);
const problems = [];

const packageJson = JSON.parse(
  await readFile(path.join(root, "package.json"), "utf8"),
);
if (packageJson.version !== version) {
  problems.push(
    `package.json is ${packageJson.version}, manifest.json is ${version}`,
  );
}

const header = await readFile(path.join(root, "tampermonkey", "header.js"), "utf8");
const headerVersion = header.match(/^\/\/ @version\s+(\S+)$/m)?.[1];
if (headerVersion !== version) {
  problems.push(
    `tampermonkey/header.js is ${headerVersion}, manifest.json is ${version}`,
  );
}

const bundle = await readFile(
  path.join(root, "tampermonkey", "rta-captcha.user.js"),
  "utf8",
);
const bundleVersion = bundle.match(/^\/\/ @version\s+(\S+)$/m)?.[1];
if (bundleVersion !== version) {
  problems.push(
    `the committed userscript is ${bundleVersion}; run npm run build:userscript`,
  );
}

const releaseTag = process.env.RELEASE_TAG ?? "";
if (releaseTag !== "" && releaseTag !== `v${version}`) {
  problems.push(`release tag ${releaseTag} does not match manifest ${version}`);
}

// An uncommitted rebuild is the other way version drift shows up: the committed
// bundle no longer matches its sources. Compare without touching the worktree.
try {
  execFileSync(
    process.execPath,
    [path.join(root, "scripts", "build-userscript.mjs"), "--check"],
    { stdio: "pipe" },
  );
} catch (error) {
  problems.push(
    `the committed userscript is out of date with its sources: ${String(
      error.stderr ?? error.message,
    ).trim()}`,
  );
}

if (problems.length > 0) {
  for (const problem of problems) {
    console.error(`version check: ${problem}`);
  }
  process.exit(1);
}
console.log(`Version check passed at ${version}.`);
