// Adds a signed release to a custom registry index (see docs/registry.md).
//
//   node scripts/build-registry-index.mjs \
//     --file termix-vscode-1.1.0.tmxplug \      the packed plugin
//     --public-key <base64> \                   from `termix-plugin keygen`
//     --url https://example.com/termix-vscode-1.1.0.tmxplug \  where it will be downloaded from
//     --out index.json \                        read if it exists, then written
//     [--registry acme] [--name "Acme Plugins"] [--notes-url <url>]
//
// The file must already be signed: `termix-plugin sign <file>` writes <file>.sig
// next to it. No secrets are read here.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((pairs, token, i, all) => {
    if (token.startsWith("--")) pairs.push([token.slice(2), all[i + 1]]);
    return pairs;
  }, []),
);
for (const required of ["file", "public-key", "url", "out"]) {
  if (!args[required]) {
    console.error(
      `missing --${required} (see the comment at the top of this script)`,
    );
    process.exit(2);
  }
}
if (!args.url.startsWith("https://")) {
  console.error("--url must be an https URL");
  process.exit(2);
}

const sigFile = `${args.file}.sig`;
if (!existsSync(sigFile)) {
  console.error(
    `${sigFile} not found: run termix-plugin sign ${args.file} first`,
  );
  process.exit(2);
}

// The registry entry has to agree with the manifest inside the file, so read it from there.
const manifest = JSON.parse(
  execFileSync("tar", ["-xzOf", args.file, "manifest.json"], {
    encoding: "utf8",
  }),
);
const bytes = readFileSync(args.file);
const sha256 = createHash("sha256").update(bytes).digest("hex");
const signature = readFileSync(sigFile, "utf8").trim();
const api = /(\d+)/.exec(manifest.engine?.api ?? "")?.[1] ?? "1";

const version = {
  version: manifest.version,
  api,
  url: args.url,
  sha256,
  signature,
  size: statSync(args.file).size,
  capabilities: manifest.capabilities,
  ...(args["notes-url"] ? { releaseNotesUrl: args["notes-url"] } : {}),
  publishedAt: new Date().toISOString(),
};

const index = existsSync(args.out)
  ? JSON.parse(readFileSync(args.out, "utf8"))
  : {
      $schema:
        "https://raw.githubusercontent.com/Termix-SSH/Termix-Registry/main/registry-index-schema.json",
      registry: args.registry ?? "community-plugins",
      name: args.name ?? "Plugins",
      apiVersion: 1,
      publicKey: args["public-key"],
      updatedAt: "",
      plugins: [],
    };

if (index.publicKey !== args["public-key"]) {
  console.error(
    "this index was written with a different public key; Termix would stop trusting it. Aborting.",
  );
  process.exit(2);
}

let entry = index.plugins.find((plugin) => plugin.id === manifest.id);
if (!entry) {
  entry = { id: manifest.id, versions: [] };
  index.plugins.push(entry);
}
Object.assign(entry, {
  name: manifest.name,
  description: manifest.description,
  author: manifest.author?.name ?? "",
  category: manifest.category,
  repository: manifest.repository,
  icon: manifest.icon,
  ...(manifest.features ? { features: manifest.features } : {}),
  ...(manifest.docs ? { docs: manifest.docs } : {}),
});
entry.versions = [
  version,
  ...entry.versions.filter((existing) => existing.version !== version.version),
];
index.updatedAt = version.publishedAt;

writeFileSync(args.out, `${JSON.stringify(index, null, 2)}\n`);
console.log(
  `${args.out}: ${manifest.id} ${manifest.version} sha256 ${sha256.slice(0, 12)}…`,
);
