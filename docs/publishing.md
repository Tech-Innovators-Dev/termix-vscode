# Publishing checklist

For maintainers. Nothing here is automated; each step publishes something under the repository owner's account.

## First release as a community plugin

1. Create the public GitHub repository and push this code. Confirm `repository` and `docs` in `manifest.json` (and
   `repository` in `package.json`) point at it.
2. In the repository's settings, turn on **Private vulnerability reporting** (SECURITY.md relies on it).
3. Create the branch `dev-X.Y.Z` for the version in `manifest.json`, `package.json` and the newest `CHANGELOG.md`
   section. The CI workflow must pass.
4. Run the **Release** workflow by hand from that branch with `stable` and `dry-run` first, then `release`. No secrets
   are needed: it records build provenance, which needs `id-token: write` and `attestations: write` in
   `.github/workflows/release.yml`. The run summary shows the version and sha256 to submit.
5. Fork [Termix-SSH/Termix-Registry](https://github.com/Termix-SSH/Termix-Registry) and add
   `community/plugins/termix-vscode.json`:

   ```json
   {
     "$schema": "../../community-submission-schema.json",
     "id": "termix-vscode",
     "repository": "https://github.com/<owner>/<repo>",
     "maintainers": ["<your GitHub username>"],
     "versions": [{ "version": "X.Y.Z", "sha256": "<from the run summary>" }]
   }
   ```

6. Open a pull request. A check downloads the release and verifies the hash, the manifest, the provenance and that you are
   a listed maintainer; a person then reviews the source before it is listed.

## Updates

Release the new version, then open a pull request that adds it to the top of `versions`. Every version is reviewed. A
release that is overwritten after review drops out of the registry until it is submitted again.

## Before each release

- `npm ci && npm test && npm run typecheck && npm run validate && npm run build && npm run format:check`
- `npm run notice:check` (run `npm run notice` if a bundled dependency changed)
- With a real code-server and Termix available, also run the opt-in tiers described in the README.
