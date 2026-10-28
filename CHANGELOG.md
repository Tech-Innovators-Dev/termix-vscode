# Changelog

## 1.1.0

### Added

- Choose what VS Code opens. Each host can list named workspaces (folders or `.code-workspace` files) in its settings, one `Name = path` per line.
- The tab opens the last workspace used on that host. With no history it asks, offering the host's named workspaces, recent paths, and a path field filled with the host's default workspace.
- The host's "Open in VS Code" button lists **Last used**, each named workspace and **Other path…**. Tabs opened from a named workspace are labelled `host · workspace`. Named workspaces are also in the command palette, and "Open VS Code at a path…" always asks.
- A path that is not on the host is reported and forgotten instead of opening the wrong folder.

### Fixed

- Opening a second VS Code session on the same host as the same user no longer fails: each session now has its own code-server data directory, sharing settings and extensions.
- code-server's own "last opened folder" no longer overrides the workspace you chose.
- Stopping a session now ends code-server's child processes too, and the host watchdog with it.
- A single file is refused with an explanation, since code-server opens an empty window for it.

## 1.0.0

### Added

- Open a web-based VS Code workspace (code-server) on a saved SSH host, in a tab.
- Per-host settings for the code-server path and the default workspace.
- Sessions belong to the user who started them, are limited to five per user, stop when idle, and are
  stopped on the host by a watchdog if Termix goes away.
