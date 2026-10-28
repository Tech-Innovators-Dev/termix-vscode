import type {
  PluginHostRecord,
  ShellApi,
  TermixApp,
} from "@termix-ssh/plugin-sdk/frontend";
import { Code2 } from "lucide-react";
import { VSCodeTab } from "./components/VSCodeTab.js";
import {
  TAB,
  namedWorkspaces,
  openVSCode,
  paletteItems,
} from "./workspace-items.js";

export function activate(app: TermixApp) {
  app.registerTab(TAB, VSCodeTab, {
    icon: Code2,
    titleKey: "tab.title",
    requiresHost: true,
    noHostMessageKey: "tab.noHost",
    session: true,
    multiInstance: true,
  });

  app.registerHostAction({
    id: "vscode.openHost",
    titleKey: "action.open",
    icon: Code2,
    kind: "open",
    tabType: TAB,
    when: () => true,
    // Offered as a picker where the shell shows one. With no named workspace
    // there is nothing to pick, and the action opens the tab directly.
    items: (host) => {
      const named = namedWorkspaces(host);
      if (named.length === 0) return [];
      return [
        {
          id: "last",
          label: app.t("action.last"),
          run: (target: PluginHostRecord, shell: ShellApi) =>
            openVSCode(shell, target),
        },
        ...named.map((workspace) => ({
          id: `workspace:${workspace.name}`,
          label: workspace.name,
          run: (target: PluginHostRecord, shell: ShellApi) =>
            openVSCode(
              shell,
              target,
              { workspacePath: workspace.path },
              workspace.name,
            ),
        })),
        {
          id: "other",
          label: app.t("action.other"),
          run: (target: PluginHostRecord, shell: ShellApi) =>
            openVSCode(shell, target, { prompt: true }),
        },
      ];
    },
  });

  app.registerPaletteEntry({
    id: "vscode.openAtPath",
    titleKey: "palette.openAtPath",
    icon: Code2,
    scope: "host",
    run: (shell, host) => host && openVSCode(shell, host, { prompt: true }),
  });

  app.registerPaletteGroup({
    id: "workspaces",
    titleKey: "palette.group",
    load: async () => {
      // A failed lookup must not break the palette, only leave this group empty.
      const hosts = await app.listHosts().catch(() => []);
      return paletteItems(hosts, (workspace, host) =>
        app.t("palette.workspaceOn", { workspace, host }),
      );
    },
  });
}
