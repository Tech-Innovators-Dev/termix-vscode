# Remote VS Code for Termix

Open a web-based VS Code workspace on any saved SSH host, in a Termix tab.

Termix connects to the host over its saved SSH login, starts [code-server](https://github.com/coder/code-server)
bound to `127.0.0.1` there, and proxies it into the tab. Nothing listens on the Termix server, and closing the tab
stops the remote process.

> This is a community plugin. It is not made or endorsed by the Termix project.

## Features

- Open VS Code on a host from its **Open in VS Code** button, with no setup on the host beyond code-server itself
- Name the folders and `.code-workspace` files you use on a host and pick one from a menu
- Reopens the last workspace you used on a host, or asks when there is no history
- Several workspaces open on one host at the same time
- Sessions belong to the user who started them, are capped per user, stop when idle, and are cleaned up on the host
  even if Termix goes away

## Requirements

- Termix 26.10.2 or newer (plugin API 1.3 or newer)
- [code-server](https://coder.com/docs/code-server/install) installed on the host, on the SSH user's `PATH` or set in the
  host's **code-server path** setting
- Connect access to the host and the `termix-vscode.use` permission (granted to the admin and user roles by default)

## Install

- **From the community registry** (once listed): an admin turns on **Community** under Plugins, Registries, then
  installs **Remote VS Code** from Browse.
- **From your own registry**: see [docs/registry.md](docs/registry.md).
- **From a file**: turn on Plugin developer mode (Settings, General), then Plugins, Install from file, and pick the
  `.tmxplug` from a release. Plugins installed this way are marked unverified.

## Use

1. In the host's settings, open the **Remote VS Code** section. Optionally list **Workspaces**, one per line as
   `Name = path`, and set the **Default workspace**:

   ```
   API = ~/work/api
   Infra = ~/work/infra/infra.code-workspace
   ```

2. Click the host's **Open in VS Code** button. With named workspaces it opens a menu (**Last used**, each workspace,
   **Other path…**). Without any it opens the last workspace, or asks.

More detail is in [docs/index.md](docs/index.md).

## What it asks for, and why

| Capability        | Why                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------- |
| `ssh:connect`     | Runs a short shell script on the host to find and start code-server, and carries traffic |
| `credentials:use` | Connects with the host's saved login, as Termix's own terminal does. It never sees it    |
| `network:serve`   | Serves the proxied VS Code page and its WebSockets under `/plugin-api` and `/plugin-ws`  |
| `ui:surface`      | Adds the tab, the host button and the command palette entries                            |

It makes no outbound requests, collects no telemetry, and downloads and runs nothing at runtime. The scripts it runs on
the host are in [`src/backend/remote-scripts.ts`](src/backend/remote-scripts.ts); every value in them is quoted, and
`npm test` checks that hostile paths are treated as data.

## Security

Read this before you enable it.

- **It runs a code-server on your host and gives the signed-in Termix user a full editor and terminal there**, with
  the privileges of the host's SSH user. That is the point of the plugin, so grant `termix-vscode.use` accordingly.
- **code-server runs with `--auth none`.** It is bound to `127.0.0.1` on the host and reachable only through an SSH
  channel that Termix opens, behind Termix's own login. Each session can only be reached by the user who started it,
  over HTTP and over WebSockets. Termix cookies and authorization headers are not forwarded to the host.
- **The editor page is served from the Termix origin.** A sandboxed iframe would break code-server, so script in a
  hostile workspace, extension or webview could act with the same origin as Termix. **Only open workspaces you trust,
  on hosts you trust.** This cannot be fixed inside a plugin; it would need a separate origin.
- Closing the tab stops the session. A session with no open socket and no request for 15 minutes is stopped. If
  Termix dies, a small watchdog on the host stops code-server once its heartbeat is three minutes old.

To report a vulnerability, use GitHub's private vulnerability reporting on this repository (see
[SECURITY.md](SECURITY.md)).

## Development

```bash
npm ci
npm run build       # build into dist/
npm test            # unit, integration and (when available) browser tests
npm run typecheck
npm run validate
npm run format:check
```

Tests that need more than Node are skipped unless their tools are present:

- `CODE_SERVER_BIN=/path/to/code-server` also runs the suite against a real code-server (needs Chrome).
- `TERMIX_E2E_URL`, `TERMIX_E2E_USER` and `TERMIX_E2E_PASSWORD` run `tests/backend/termix-e2e.test.ts` against a real
  Termix with the plugin installed and a host with code-server (see the comments in that file).

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Apache License 2.0. Third-party notices are in [NOTICE](NOTICE).
