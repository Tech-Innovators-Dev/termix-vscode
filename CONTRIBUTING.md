# Contributing

## Development

```bash
npm ci
npm run build      # build into dist/
npm test           # tests (Node, jsdom, and a browser when Chrome is present)
npm run typecheck
npm run validate   # check manifest.json and the files it names
npm run format     # format with Prettier
```

`npm run build` writes readable, unminified bundles. Run `node scripts/generate-notice.mjs` after changing a
dependency that ends up in `dist/`, and commit `NOTICE`.

## Layout

- `src/backend`: the routes, the SSH session manager and the scripts run on the host
- `src/frontend`: the tab, the workspace chooser and the host action
- `src/shared`: code both sides use (the workspace list format)
- `tests/backend`, `tests/frontend`: tests. `tests/backend/support` holds a stand-in code-server, a fake SSH server and a
  copy of core's routing rules for the integration tests

## Releasing

Work on a `dev-X.Y.Z` branch named after the version it ships as. Keep `manifest.json`, `package.json` and the newest
`CHANGELOG.md` section on the same version, and run the **Release** workflow by hand from that branch. See
https://docs.termix.site/develop/releasing.

## Commits

Conventional commits (`feat:`, `fix:`, `docs:` …) keep the release notes readable.
