# Notes for AI tools

Remote VS Code is a Termix plugin: it starts code-server on a host over SSH and proxies it into a tab. Read
`README.md` first, and the Termix plugin guide at `node_modules/@termix-ssh/plugin-sdk/PLUGIN-GUIDE.md`.

## Commands

`npm run build`, `npm test`, `npm run typecheck`, `npm run validate`, `npm run format:check`.

## Things that are easy to get wrong

- Core matches WebSocket routes exactly under `/plugin-ws/<id>/<path>` and only nginx-upgrades that prefix. code-server
  opens sockets relative to its page, so `src/backend/ws-shim.ts` rewrites them to the one route `/vscode`.
- Every script run on the host goes through `sh -s` on stdin, with each value passed through `shQuote`. `/bin/sh` may be
  dash: use `kill -s TERM -- -PID`, not `kill -TERM -- -PID`.
- code-server hands a second launch to a running instance that shares its data directory, and ignores the folder it was
  given if it remembers a last-opened one. Each session therefore gets its own `--user-data-dir` (settings and extensions
  linked to the shared ones) and `--ignore-last-opened`.
- A single file cannot be opened (code-server shows an empty window), so the script refuses it.
- Sessions belong to the user who started them. Check ownership on every HTTP and socket path.
- Tests that start real processes must clean them up; `npm test` should leave nothing running.
- Do not add telemetry, network calls or code that is fetched at runtime.
