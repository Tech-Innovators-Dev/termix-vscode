# Install from your own registry

A custom registry lets you install the plugin without developer mode, as a plugin Termix has verified against your
signing key. Everything below was run against Termix 26.10.5.

## 1. Make a signing key (once)

```bash
npx termix-plugin keygen --out ~/.config/termix-vscode-signing
```

It writes `termix-plugin-signing.key` (the private key) and prints the public key and its **key id**. Keep the private
key out of the repository and back it up: if you lose it you cannot sign updates, and changing the key makes Termix stop
trusting the registry until an admin removes it and adds it again (plugins installed from it must be uninstalled first).
Anyone with the private key can sign plugins your registry's users will trust.

## 2. Build, pack and sign a release

```bash
npm ci && npm run build && npm run validate && npm run pack
TERMIX_PLUGIN_SIGNING_KEY="$(cat ~/.config/termix-vscode-signing/termix-plugin-signing.key)" \
  npx termix-plugin sign termix-vscode-1.1.0.tmxplug
npx termix-plugin verify termix-vscode-1.1.0.tmxplug --key <public key>
```

`sign` writes `termix-vscode-1.1.0.tmxplug.sig`. Upload the `.tmxplug` to a place with an **https** URL, such as a GitHub
release.

## 3. Add it to the index

```bash
node scripts/build-registry-index.mjs \
  --file termix-vscode-1.1.0.tmxplug \
  --public-key <public key> \
  --url https://github.com/<owner>/<repo>/releases/download/v1.1.0/termix-vscode-1.1.0.tmxplug \
  --registry <short-id> --name "<Registry name>" \
  --out index.json
```

The script reads the manifest from inside the file, so the entry matches it (Termix refuses a file whose id, version or
capabilities differ). Running it again for a new version adds the version to the top of the list and keeps the rest.

## 4. Host the index

Put `index.json` on any **https** URL that serves it as JSON (a raw file in a GitHub repo, GitHub Pages, your web
server). Termix refuses an `http` registry. Termix caches the index for 15 minutes.

For a registry on a private address (a server in your LAN), also set `TERMIX_PLUGIN_REGISTRY_PRIVATE_HOSTS` on the
Termix server to the registry's host name. It must still be https, with a certificate Termix trusts.

## 5. Add it in Termix

Plugins, Registries, **Add registry**, paste the index URL, **Check**, compare the key id with the one `keygen` printed,
then **Trust and add**. The plugin appears in Browse; install it and review the capabilities it asks for. Developer
mode can stay off.

If the plugin was installed from a file before, uninstall that copy first: a plugin only updates from the registry it
came from.

## What Termix checks

Run against a registry set up this way:

- the preview shows the key id from the index, and adding it requires that id
- the download must match the sha256 in the index (a file with one byte added was refused)
- the capabilities you agree to must match the release's (a shorter list was refused)
