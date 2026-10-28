// Writes NOTICE: the licence text of every third-party package that ends up in
// dist/. Run it after changing dependencies, then commit the result.
//
//   node scripts/generate-notice.mjs          write NOTICE
//   node scripts/generate-notice.mjs --check  fail if NOTICE is out of date
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Taken from the source maps of dist/backend.js and dist/frontend.js.
const BUNDLED = [
  "http-proxy",
  "eventemitter3",
  "follow-redirects",
  "requires-port",
  "debug",
  "ms",
  "lucide-react",
];

function licenseText(dir) {
  for (const name of [
    "LICENSE",
    "LICENSE.md",
    "LICENSE.txt",
    "license",
    "license.md",
  ]) {
    const file = path.join(dir, name);
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  }
  throw new Error(`no licence file in ${dir}`);
}

const sections = BUNDLED.map((name) => {
  const dir = path.join(root, "node_modules", name);
  const pkg = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8"));
  return [
    `${name} ${pkg.version} (${pkg.license})`,
    "-".repeat(72),
    licenseText(dir),
  ].join("\n");
});

const notice = [
  "Remote VS Code for Termix",
  "Licensed under the Apache License, Version 2.0 (see LICENSE).",
  "",
  "This plugin bundles the following third-party software. Each is used under its own licence, reproduced below.",
  "",
  sections.join("\n\n\n"),
  "",
].join("\n");

const target = path.join(root, "NOTICE");
if (process.argv.includes("--check")) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current !== notice) {
    console.error(
      "NOTICE is out of date. Run: node scripts/generate-notice.mjs",
    );
    process.exit(1);
  }
} else {
  writeFileSync(target, notice);
  console.log(`wrote NOTICE (${BUNDLED.length} packages)`);
}
