import type {
  PaletteItem,
  PluginHostRecord,
  ShellApi,
} from "@termix-ssh/plugin-sdk/frontend";
import { Code2 } from "lucide-react";
import { parseWorkspaces } from "../shared/workspaces.js";

export const TAB = "vscode-session";
export const PLUGIN_ID = "termix-vscode";

/** The named workspaces a host keeps in its own plugin settings. */
export function namedWorkspaces(host: PluginHostRecord) {
  return parseWorkspaces(host.pluginSettings?.[PLUGIN_ID]?.workspaces).entries;
}

/** Opens a VS Code tab on `host`, always as a new tab. */
export function openVSCode(
  shell: ShellApi,
  host: PluginHostRecord,
  data?: Record<string, unknown>,
  workspaceName?: string,
) {
  // Tabs for one host differ only by workspace, so the name goes in the label.
  const label = workspaceName ? `${host.name} · ${workspaceName}` : undefined;
  shell.openTab(host, TAB, {
    forceNewTab: true,
    data,
    ...(label ? { label } : {}),
  });
}

/** One palette row per named workspace on every host. */
export function paletteItems(
  hosts: PluginHostRecord[],
  title: (workspace: string, host: string) => string,
): PaletteItem[] {
  return hosts.flatMap((host) =>
    namedWorkspaces(host).map((workspace) => ({
      id: `${host.id}:${workspace.name}`,
      title: title(workspace.name, host.name),
      description: workspace.path,
      icon: Code2,
      keywords: [host.name, workspace.name, workspace.path],
      run: ({ shell }: { shell: ShellApi }) =>
        openVSCode(
          shell,
          host,
          { workspacePath: workspace.path },
          workspace.name,
        ),
    })),
  );
}
