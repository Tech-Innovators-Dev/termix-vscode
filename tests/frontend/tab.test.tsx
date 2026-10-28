import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { renderWithApp } from "@termix-ssh/plugin-sdk/testing";
import { afterEach, describe, expect, test, vi } from "vitest";
import * as plugin from "../../src/frontend/index.js";
import { paletteItems } from "../../src/frontend/workspace-items.js";
import locales from "../../locales/en.json" with { type: "json" };
import manifest from "../../manifest.json" with { type: "json" };

// Rendering the real plugin host is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

afterEach(cleanup);

const host = { id: "7", name: "build-box", ip: "10.0.0.7", port: 22 };
const hostWithWorkspaces = {
  ...host,
  pluginSettings: {
    "termix-vscode": {
      workspaces: "API = ~/work/api\nInfra = ~/infra/main.code-workspace",
    },
  },
};
const RUNNING = {
  data: {
    sessionId: "0123456789abcdef",
    iframeUrl: "http://t/plugin-api/termix-vscode/session/0123456789abcdef/",
  },
};

interface Info {
  default: string;
  named: { name: string; path: string }[];
  recent: string[];
}
const NO_INFO: Info = { default: "~", named: [], recent: [] };

function apiStub(
  options: {
    start?: () => Promise<{ data: unknown }>;
    info?: Info | Error;
  } = {},
) {
  const start = options.start ?? (async () => RUNNING);
  const get = vi.fn(async () => {
    if (options.info instanceof Error) throw options.info;
    return { data: options.info ?? NO_INFO };
  });
  const post = vi.fn(async (url: string) =>
    url === "/session/start" ? start() : { data: { success: true } },
  );
  return { post, get, put: vi.fn(), delete: vi.fn() };
}

async function render(
  api = apiStub(),
  hosts: Array<Record<string, unknown>> = [],
) {
  const app = await renderWithApp(plugin, {
    manifest: manifest as never,
    locales,
    api: api as never,
    hosts,
  });
  return { app, api };
}

const open = (
  app: Awaited<ReturnType<typeof render>>["app"],
  data?: Record<string, unknown>,
  h = host,
) =>
  app.renderTab("vscode-session", {
    host: h,
    isVisible: true,
    tab: { id: "t1", type: "vscode-session", label: "VS Code", data },
  });

const starts = (api: ReturnType<typeof apiStub>) =>
  api.post.mock.calls
    .filter(([url]) => url === "/session/start")
    .map(([, body]) => body);

describe("registration", () => {
  test("registers the declared tab and a host action that opens it", async () => {
    const { app } = await render();
    expect(app.registered.tabs()).toEqual(["vscode-session"]);
    expect(app.registered.hostActions()).toEqual([
      { id: "vscode.openHost", tabType: "vscode-session" },
    ]);
    expect(manifest.contributes.tabs.map((tab) => tab.id)).toEqual([
      "vscode-session",
    ]);
  });

  test("the host action is offered for any host", async () => {
    const { app } = await render();
    expect(
      app.registered.hostActionsFor(host).map((action) => action.id),
    ).toContain("vscode.openHost");
  });

  test("disable then enable registers again", async () => {
    const first = await render();
    await first.app.deactivate();
    const second = await render();
    expect(second.app.registered.tabs()).toEqual(["vscode-session"]);
  });

  test("the host action lists each named workspace plus 'Other path…', and opens the tab with it", async () => {
    const { app } = await render();
    const action = app.registered
      .hostActionsFor(hostWithWorkspaces)
      .find((a) => a.id === "vscode.openHost")!;
    const items = action.items!(hostWithWorkspaces as never);
    expect(items.map((item) => item.label)).toEqual([
      locales.action.last,
      "API",
      "Infra",
      locales.action.other,
    ]);

    const shell = { openTab: vi.fn() };
    items[0].run(hostWithWorkspaces as never, shell as never);
    items[2].run(hostWithWorkspaces as never, shell as never);
    items[3].run(hostWithWorkspaces as never, shell as never);
    expect(shell.openTab.mock.calls).toEqual([
      // "Last used": a plain tab, which reopens the last workspace or asks.
      [
        hostWithWorkspaces,
        "vscode-session",
        { forceNewTab: true, data: undefined },
      ],
      [
        hostWithWorkspaces,
        "vscode-session",
        {
          forceNewTab: true,
          label: "build-box · Infra",
          data: { workspacePath: "~/infra/main.code-workspace" },
        },
      ],
      [
        hostWithWorkspaces,
        "vscode-session",
        { forceNewTab: true, data: { prompt: true } },
      ],
    ]);
  });

  test("a host with no named workspaces offers no picker, so the action opens the tab directly", async () => {
    const { app } = await render();
    const action = app.registered
      .hostActionsFor(host)
      .find((a) => a.id === "vscode.openHost")!;
    expect(action.items!(host as never)).toEqual([]);
  });

  test("the palette rows are one per named workspace on every host, and open the tab with it", () => {
    const items = paletteItems(
      [hostWithWorkspaces, { ...host, id: "8", name: "plain" }] as never,
      (workspace, hostName) => `${workspace} on ${hostName}`,
    );
    expect(items.map((item) => item.title)).toEqual([
      "API on build-box",
      "Infra on build-box",
    ]);
    expect(items.map((item) => item.description)).toEqual([
      "~/work/api",
      "~/infra/main.code-workspace",
    ]);

    const shell = { openTab: vi.fn() };
    items[1].run({ shell } as never);
    expect(shell.openTab).toHaveBeenCalledWith(
      hostWithWorkspaces,
      "vscode-session",
      {
        forceNewTab: true,
        label: "build-box · Infra",
        data: { workspacePath: "~/infra/main.code-workspace" },
      },
    );
  });

  test("a failing host lookup leaves the palette group empty instead of breaking it", async () => {
    const { app } = await render();
    app.app.listHosts = async () => {
      throw new Error("offline");
    };
    expect(await app.loadPaletteGroup("workspaces")).toEqual([]);
  });
});

describe("opening the workspace", () => {
  test("a workspace the tab was opened with is used, without asking or looking anything up", async () => {
    const { app, api } = await render();
    open(app, { workspacePath: "~/work/api" });
    await screen.findByTitle(locales.tab.title);
    expect(starts(api)).toEqual([{ hostId: 7, workspacePath: "~/work/api" }]);
    expect(api.get).not.toHaveBeenCalled();
  });

  test("with history, the last workspace opens straight away", async () => {
    const { app, api } = await render(
      apiStub({ info: { default: "~", named: [], recent: ["~/b", "~/a"] } }),
    );
    open(app);
    await screen.findByTitle(locales.tab.title);
    expect(starts(api)).toEqual([{ hostId: 7, workspacePath: "~/b" }]);
  });

  test("with no history, it asks, listing the host's named workspaces", async () => {
    const info = {
      default: "~",
      named: [
        { name: "API", path: "~/work/api" },
        { name: "Infra", path: "~/infra" },
      ],
      recent: [],
    };
    const { app, api } = await render(apiStub({ info }));
    open(app);
    expect(await screen.findByText(locales.tab.choose)).toBeTruthy();
    expect(starts(api)).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: /Infra/ }));
    await screen.findByTitle(locales.tab.title);
    expect(starts(api)).toEqual([{ hostId: 7, workspacePath: "~/infra" }]);
  });

  test("with no history and nothing named, it asks for a path, prefilled with the host default", async () => {
    const { app, api } = await render(
      apiStub({ info: { default: "/srv/www", named: [], recent: [] } }),
    );
    open(app);
    const input = (await screen.findByLabelText(
      locales.tab.pathLabel,
    )) as HTMLInputElement;
    expect(input.value).toBe("/srv/www");

    fireEvent.change(input, { target: { value: "  /srv/other  " } });
    fireEvent.click(screen.getByRole("button", { name: locales.tab.open }));
    await screen.findByTitle(locales.tab.title);
    expect(starts(api)).toEqual([{ hostId: 7, workspacePath: "/srv/other" }]);
  });

  test("the Open button does nothing for an empty path", async () => {
    const { app, api } = await render();
    open(app);
    const input = (await screen.findByLabelText(
      locales.tab.pathLabel,
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "   " } });
    expect(
      (
        screen.getByRole("button", {
          name: locales.tab.open,
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(starts(api)).toEqual([]);
  });

  test("'Other path…' asks even when there is history, and offers the history as choices", async () => {
    const { app, api } = await render(
      apiStub({ info: { default: "~", named: [], recent: ["~/b", "~/a"] } }),
    );
    open(app, { prompt: true });
    expect(await screen.findByText(locales.tab.choose)).toBeTruthy();
    expect(screen.getByRole("button", { name: "~/a" })).toBeTruthy();
    expect(starts(api)).toEqual([]);
  });

  test("a path missing on the host sends the user back to choose, with the path shown", async () => {
    let attempt = 0;
    const api = apiStub({
      info: { default: "~", named: [], recent: ["~/gone"] },
      start: async () => {
        if (++attempt === 1)
          throw { response: { data: { code: "WORKSPACE_NOT_FOUND" } } };
        return RUNNING;
      },
    });
    const { app } = await render(api);
    open(app);

    expect(
      await screen.findByText(
        locales.tab.missingDetail.replace("{{path}}", "~/gone"),
      ),
    ).toBeTruthy();
    // The server forgot it, so the chooser must not start it again on its own.
    expect(starts(api)).toEqual([{ hostId: 7, workspacePath: "~/gone" }]);

    const input = screen.getByLabelText(
      locales.tab.pathLabel,
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "~/real" } });
    fireEvent.click(screen.getByRole("button", { name: locales.tab.open }));
    await screen.findByTitle(locales.tab.title);
    expect(starts(api).at(-1)).toEqual({ hostId: 7, workspacePath: "~/real" });
  });

  test("a single file is explained, and the user can pick something else", async () => {
    const api = apiStub({
      start: async () => {
        throw { response: { data: { code: "WORKSPACE_UNSUPPORTED" } } };
      },
    });
    const { app } = await render(api);
    open(app, { workspacePath: "~/notes.txt" });
    expect(
      await screen.findByText(
        locales.tab.unsupportedDetail.replace("{{path}}", "~/notes.txt"),
      ),
    ).toBeTruthy();
    expect(
      (screen.getByLabelText(locales.tab.pathLabel) as HTMLInputElement).value,
    ).toBe("~/notes.txt");
  });

  test("if the workspace lookup fails it still lets the user type a path", async () => {
    const { app } = await render(apiStub({ info: new Error("offline") }));
    open(app);
    const input = (await screen.findByLabelText(
      locales.tab.pathLabel,
    )) as HTMLInputElement;
    expect(input.value).toBe("~");
  });
});

describe("the rest of the tab", () => {
  test("shows progress, then the workspace in an iframe", async () => {
    let finish!: (value: { data: unknown }) => void;
    const { app } = await render(
      apiStub({ start: () => new Promise((resolve) => (finish = resolve)) }),
    );
    open(app, { workspacePath: "~" });
    expect(await screen.findByText(locales.tab.launching)).toBeTruthy();
    finish(RUNNING);
    const frame = (await screen.findByTitle(
      locales.tab.title,
    )) as HTMLIFrameElement;
    expect(frame.getAttribute("src")).toBe(RUNNING.data.iframeUrl);
    expect(frame.style.display).toBe("block");
  });

  test("keeps the iframe mounted but hidden when the tab is in the background", async () => {
    const { app } = await render();
    app.renderTab("vscode-session", {
      host,
      isVisible: false,
      tab: {
        id: "t",
        type: "vscode-session",
        label: "x",
        data: { workspacePath: "~" },
      },
    });
    const frame = (await screen.findByTitle(
      locales.tab.title,
    )) as HTMLIFrameElement;
    expect(frame.style.display).toBe("none");
  });

  test("explains a missing code-server and offers a retry that starts again", async () => {
    let attempts = 0;
    const api = apiStub({
      start: async () => {
        if (++attempts === 1)
          throw { response: { data: { code: "NOT_INSTALLED" } } };
        return RUNNING;
      },
    });
    const { app } = await render(api);
    open(app, { workspacePath: "~" });
    expect(await screen.findByText(locales.tab.notInstalled)).toBeTruthy();
    // A link to the guide, and no command to paste into a shell.
    const guide = screen.getByRole("link", { name: locales.tab.installGuide });
    expect(guide.getAttribute("href")).toBe(
      "https://coder.com/docs/code-server/install",
    );
    expect(guide.getAttribute("rel")).toContain("noopener");
    expect(document.body.textContent).not.toMatch(/curl|\| sh/);
    fireEvent.click(screen.getByRole("button", { name: locales.tab.retry }));
    await screen.findByTitle(locales.tab.title);
    expect(starts(api)).toHaveLength(2);
  });

  test("says when the user has too many sessions open", async () => {
    const api = apiStub({
      start: async () => {
        throw { response: { data: { code: "TOO_MANY_SESSIONS" } } };
      },
    });
    const { app } = await render(api);
    open(app, { workspacePath: "~" });
    expect(await screen.findByText(locales.tab.tooMany)).toBeTruthy();
  });

  test("shows the server's message when starting fails", async () => {
    const { app } = await render(
      apiStub({
        start: async () => {
          throw { response: { data: { error: "ssh: connection refused" } } };
        },
      }),
    );
    open(app, { workspacePath: "~" });
    expect(await screen.findByText(locales.tab.error)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByText("ssh: connection refused")).toBeTruthy(),
    );
  });

  test("a tab opened without a host says so instead of starting anything", async () => {
    const { app, api } = await render();
    app.renderTab("vscode-session", { isVisible: true });
    expect(await screen.findByText(locales.tab.noHost)).toBeTruthy();
    expect(starts(api)).toHaveLength(0);
    expect(api.get).not.toHaveBeenCalled();
  });
});
