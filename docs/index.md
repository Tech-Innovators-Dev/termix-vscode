# Remote VS Code

Opens a VS Code workspace in a tab by starting `code-server` on the host over its saved SSH connection and
proxying it through Termix.

## Requirements

`code-server` must be installed on the host, or its path set in the host's VS Code settings. The user needs
the `termix-vscode.use` permission and connect access to the host.

## How it works

- Termix connects with its normal SSH pipeline and starts `code-server` bound to `127.0.0.1` on the host.
- HTTP goes through the plugin's routes at `/plugin-api/termix-vscode/session/<id>/`, then through an SSH
  channel to that loopback port. Nothing listens on the Termix server.
- code-server opens its WebSockets relative to its page, which would land on `/plugin-api`. Core only upgrades
  `/plugin-ws/<id>/<exact path>`, so the plugin adds a small script to code-server's page that sends those
  sockets to `/plugin-ws/termix-vscode/vscode?s=<session>&p=<path>`.
- Only the user who started a session can reach it, over HTTP and sockets.
- Termix cookies, `Authorization` and `termix.jwt.*` subprotocols are not forwarded to the host.

## Choosing what to open

- In a host's settings, **Workspaces** lists folders or `.code-workspace` files, one per line as `Name = path`
  (`API = ~/work/api`). A line with only a path uses its last segment as the name. `~` is expanded on the host.
  **Default workspace** is the fallback path.
- Opening VS Code on a host uses the workspace you opened there last. With no history it asks: your named
  workspaces, your recent paths, and a path field filled with the default workspace.
- With named workspaces, the host's **Open in VS Code** button opens a menu: **Last used**, each named
  workspace, and **Other path…** (which always asks). Without any, the button opens the last workspace, or asks.
  Named workspaces are also in the command palette (**VS Code workspaces**).
- A path that does not exist on the host is reported and dropped from the history. A single file is refused:
  code-server opens folders and `.code-workspace` files only.
- Each tab starts its own code-server with its own data directory, so several workspaces can be open on one host
  at once. Settings and extensions are shared with the host user's regular code-server.

## Lifetime

- Closing the tab stops the session and the remote process.
- A session with no open socket and no request for 15 minutes is stopped.
- If the SSH connection drops the session ends in Termix. Termix touches a heartbeat file on the host every
  minute; a small watchdog started with `code-server` stops it and removes `~/.termix/vscode/<id>` once the
  file is three minutes old, so a Termix crash does not leave servers running.
- Each user can have five sessions open at once.

## Limitations

- The code-server page is served from the Termix origin (a sandboxed iframe would break code-server). A
  hostile workspace, extension or webview could run script with the same origin as Termix. Open workspaces
  you trust, on hosts you trust.
- The plugin has been exercised against a stand-in for code-server and in headless Chrome, not yet against
  a real code-server build.
