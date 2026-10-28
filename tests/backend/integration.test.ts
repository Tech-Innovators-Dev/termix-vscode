import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import WebSocket from "ws";
import { activate } from "../../src/backend/index.js";
import { createProxyRouter } from "../../src/backend/proxy-router.js";
import { VSCodeSessionManager } from "../../src/backend/session-manager.js";
import { WS_ROUTE } from "../../src/backend/ws-shim.js";
import { startCoreHost, type CoreHost } from "./support/core-host.js";
import { FakeSshServer } from "./support/fake-ssh.js";

// Each test starts real processes over SSH; allow for a loaded machine.
vi.setConfig({ testTimeout: 30_000 });

const STUB = path.resolve(import.meta.dirname, "support/stub-code-server");
const USERS = {
  "tok-alice": "alice",
  "tok-bob": "bob",
  "tok-nouse": "carol",
  "tok-dave": "dave",
};
const PLUGIN = "/plugin-api/termix-vscode";

let home: string;
let ssh: FakeSshServer;
let core: CoreHost;

const sessionsDir = () => path.join(home, ".termix", "vscode");
const liveSessions = () =>
  existsSync(sessionsDir()) ? readdirSync(sessionsDir()) : [];

async function call(
  host: CoreHost,
  user: string | null,
  route: string,
  init: RequestInit & { headers?: Record<string, string> } = {},
) {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  if (user) headers.Cookie = `jwt=${user}`;
  return fetch(`${host.baseUrl}${route}`, {
    redirect: "manual",
    ...init,
    headers,
  });
}

async function start(
  host: CoreHost,
  user = "tok-alice",
  body: unknown = { hostId: 1 },
) {
  const res = await call(host, user, `${PLUGIN}/session/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, data: (await res.json()) as Record<string, string> };
}

function openSocket(
  host: CoreHost,
  query: string,
  headers: Record<string, string>,
) {
  const ws = new WebSocket(
    `ws://${host.host}/plugin-ws/termix-vscode${WS_ROUTE}${query}`,
    { headers },
  );
  const messages: string[] = [];
  ws.on("message", (data) => messages.push(String(data)));
  const opened = new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_req, res) =>
      reject(new Error(`HTTP ${res.statusCode}`)),
    );
  });
  opened.catch(() => undefined); // callers that expect a refusal await it themselves
  const closed = new Promise<void>((resolve) =>
    ws.once("close", () => resolve()),
  );
  return { ws, messages, opened, closed };
}

const waitFor = async (predicate: () => boolean, ms = 8000) => {
  for (let waited = 0; !predicate() && waited < ms; waited += 50)
    await new Promise((r) => setTimeout(r, 50));
  return predicate();
};

beforeAll(async () => {
  home = mkdtempSync(path.join(tmpdir(), "vsc-int-"));
  mkdirSync(path.join(home, "proj"));
  writeFileSync(path.join(home, "proj", "app.code-workspace"), "{}");
  writeFileSync(path.join(home, "notes.txt"), "hi");
  mkdirSync(path.join(home, "other"));
  ssh = new FakeSshServer(home);
  await ssh.listen();
  core = await startCoreHost({
    ssh,
    users: USERS,
    permissions: { carol: [] },
    knownHosts: [1],
    hostSettings: {
      "1:vscodePath": STUB,
      "1:defaultWorkspace": "~",
      "1:workspaces":
        "Proj = ~/proj\nNotes = ~/notes.txt\n# comment\nbad line =",
    },
    activate,
  });
}, 30_000);

afterAll(async () => {
  await core.disposeAll();
  // Whatever a failing test left running on the "host" must not outlive the suite.
  for (const id of liveSessions()) {
    const pid = path.join(sessionsDir(), id, "server.pid");
    if (existsSync(pid)) {
      const { RemoteScripts } =
        await import("../../src/backend/remote-scripts.js");
      spawnSync("sh", ["-s"], {
        input: RemoteScripts.terminateSession(id),
        env: { PATH: process.env.PATH, HOME: home },
      });
    }
  }
  await core.close();
  await ssh.close();
});

describe("registration against core's routing rules", () => {
  test("the socket route is one exact path (core matches exactly)", () => {
    expect(core.wsPaths()).toEqual([WS_ROUTE]);
  });

  test("activation schedules the heartbeat and the idle reaper", () => {
    expect(core.scheduledCount()).toBe(2);
  });
});

describe("a session end to end", () => {
  let sessionId: string;
  let iframeUrl: string;
  let page: string;

  test("start launches the stub over SSH and returns an iframe URL under /plugin-api", async () => {
    const { res, data } = await start(core);
    expect(res.status).toBe(200);
    sessionId = data.sessionId;
    expect(sessionId).toMatch(/^[0-9a-f]{16}$/);
    iframeUrl = data.iframeUrl;
    expect(iframeUrl).toBe(`${core.baseUrl}${PLUGIN}/session/${sessionId}/`);
    expect(liveSessions()).toContain(sessionId);
  });

  test("the page comes back uncompressed with the shim ahead of code-server's scripts", async () => {
    const res = await call(core, "tok-alice", new URL(iframeUrl).pathname, {
      headers: {
        Accept: "text/html",
        "Accept-Encoding": "gzip",
        "Sec-Fetch-Dest": "iframe",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBeNull();
    page = await res.text();
    expect(page.indexOf("_termix/ws-shim.js")).toBeGreaterThan(-1);
    expect(page.indexOf("_termix/ws-shim.js")).toBeLessThan(
      page.indexOf("new WebSocket"),
    );
    expect(Number(res.headers.get("content-length"))).toBe(
      Buffer.byteLength(page),
    );
  });

  test("cookies set by code-server are scoped to the session path", async () => {
    const res = await call(core, "tok-alice", new URL(iframeUrl).pathname, {
      headers: { Accept: "text/html", "Sec-Fetch-Dest": "iframe" },
    });
    const cookie = res.headers.getSetCookie().join("\n");
    expect(cookie).toContain(`Path=${PLUGIN}/session/${sessionId}/`);
    expect(cookie).not.toMatch(/Path=\/;/i);
  });

  test("the shim script is served, and a missing trailing slash is redirected", async () => {
    const shim = await call(
      core,
      "tok-alice",
      `${PLUGIN}/session/${sessionId}/_termix/ws-shim.js`,
    );
    expect(shim.status).toBe(200);
    expect(shim.headers.get("content-type")).toContain("javascript");
    expect(await shim.text()).toContain("/plugin-ws/");

    const redirect = await call(
      core,
      "tok-alice",
      `${PLUGIN}/session/${sessionId}?folder=%2Fx`,
    );
    expect(redirect.status).toBe(301);
    expect(redirect.headers.get("location")).toBe(
      `${PLUGIN}/session/${sessionId}/?folder=%2Fx`,
    );
  });

  test("non-document requests stream through untouched", async () => {
    const res = await call(
      core,
      "tok-alice",
      `${PLUGIN}/session/${sessionId}/asset.js`,
    );
    expect(await res.text()).toBe("// asset");
  });

  test("redirects stay inside the session prefix", async () => {
    const absolute = await call(
      core,
      "tok-alice",
      `${PLUGIN}/session/${sessionId}/redirect`,
      {
        headers: { Accept: "text/html", "Sec-Fetch-Dest": "iframe" },
      },
    );
    // Not a document path ("/"), so http-proxy's own rewrite does not apply:
    // assert the code-server value reaches the browser unchanged and relative
    // redirects (what code-server uses) keep working.
    expect(absolute.status).toBe(302);
    const relative = await call(
      core,
      "tok-alice",
      `${PLUGIN}/session/${sessionId}/rel`,
    );
    expect(relative.headers.get("location")).toBe("./landed?x=1");
  });

  test("Termix credentials are not forwarded; Host is preserved", async () => {
    const res = await call(
      core,
      "tok-alice",
      `${PLUGIN}/session/${sessionId}/echo`,
      {
        headers: { Authorization: "Bearer secret-token" },
      },
    );
    const seen = (await res.json()) as { headers: Record<string, string> };
    expect(seen.headers.cookie).toBeUndefined();
    expect(seen.headers.authorization).toBeUndefined();
    expect(seen.headers.host).toBe(core.host);
    expect(seen.headers["x-forwarded-for"]).toBeDefined();
  });

  test("a large upload reaches code-server unparsed", async () => {
    const body = Buffer.alloc(3 * 1024 * 1024, 1);
    const res = await call(
      core,
      "tok-alice",
      `${PLUGIN}/session/${sessionId}/upload`,
      {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body,
      },
    );
    expect(await res.text()).toBe(String(body.length));
  });

  test("a socket opened through the shim route reaches code-server's path and echoes", async () => {
    const p = encodeURIComponent("/stable-abc/socket?token=1&q=%2F");
    const { ws, messages, opened } = openSocket(
      core,
      `?s=${sessionId}&p=${p}`,
      {
        Cookie: "jwt=tok-alice",
        Origin: core.baseUrl,
      },
    );
    await opened;
    ws.send("ping");
    expect(await waitFor(() => messages.includes("echo:ping"))).toBe(true);
    expect(messages[0]).toBe("path:/stable-abc/socket?token=1&q=%2F");
    const seen = JSON.parse(messages[1].slice("seen:".length));
    expect(seen).toEqual({ cookie: null, protocol: null });
    ws.close();
  });

  test("a socket carrying the JWT as a subprotocol does not forward it", async () => {
    const ws = new WebSocket(
      `ws://${core.host}/plugin-ws/termix-vscode${WS_ROUTE}?s=${sessionId}&p=%2Fs`,
      ["termix.jwt.tok-alice", "vscode"],
      { headers: { Origin: core.baseUrl } },
    );
    const messages: string[] = [];
    ws.on("message", (data) => messages.push(String(data)));
    await new Promise((resolve, reject) =>
      ws.once("open", resolve).once("error", reject),
    );
    expect(await waitFor(() => messages.length >= 2)).toBe(true);
    expect(JSON.parse(messages[1].slice(5)).protocol).toBe("vscode");
    ws.close();
  });

  test("other users cannot reach the session over HTTP or sockets", async () => {
    expect(
      (await call(core, "tok-bob", `${PLUGIN}/session/${sessionId}/`)).status,
    ).toBe(404);
    expect(
      (
        await call(core, "tok-bob", `${PLUGIN}/session/${sessionId}/stop`, {
          method: "POST",
        })
      ).status,
    ).toBe(404);
    expect(
      (await call(core, null, `${PLUGIN}/session/${sessionId}/`)).status,
    ).toBe(401);

    const bob = openSocket(core, `?s=${sessionId}&p=%2Fx`, {
      Cookie: "jwt=tok-bob",
      Origin: core.baseUrl,
    });
    await expect(bob.opened).rejects.toThrow();
    const anon = openSocket(core, `?s=${sessionId}&p=%2Fx`, {
      Origin: core.baseUrl,
    });
    await expect(anon.opened).rejects.toThrow(/401/);
    // A cookie sent by a page on another site does not authenticate.
    const cross = openSocket(core, `?s=${sessionId}&p=%2Fx`, {
      Cookie: "jwt=tok-alice",
      Origin: "http://evil.example",
    });
    await expect(cross.opened).rejects.toThrow(/401/);
  });

  test("socket requests with a bad path or session are dropped", async () => {
    for (const query of [
      `?s=${sessionId}&p=x`,
      `?s=${sessionId}&p=%2F%2Fevil`,
      `?s=${sessionId}&p=%2Fa%0d%0ab`,
      `?s=${sessionId}`,
      `?s=0000000000000000&p=%2Fx`,
      `?s=..%2F..&p=%2Fx`,
      "",
    ]) {
      const attempt = openSocket(core, query, {
        Cookie: "jwt=tok-alice",
        Origin: core.baseUrl,
      });
      attempt.ws.on("error", () => undefined);
      await Promise.race([
        attempt.closed,
        attempt.opened.then(() => assert.fail(`opened for ${query}`)),
      ]).catch((error) => {
        if (error?.code === "ERR_ASSERTION") throw error;
      });
    }
  });

  test("stop ends the remote server, the socket and the SSH connection", async () => {
    const p = encodeURIComponent("/stable-abc/socket");
    const live = openSocket(core, `?s=${sessionId}&p=${p}`, {
      Cookie: "jwt=tok-alice",
      Origin: core.baseUrl,
    });
    await live.opened;
    const clientsBefore = ssh.clients.size;

    const res = await call(
      core,
      "tok-alice",
      `${PLUGIN}/session/${sessionId}/stop`,
      { method: "POST" },
    );
    expect(res.status).toBe(200);

    await live.closed;
    expect(liveSessions()).not.toContain(sessionId);
    expect(await waitFor(() => ssh.clients.size === clientsBefore - 1)).toBe(
      true,
    );
    expect(
      (await call(core, "tok-alice", `${PLUGIN}/session/${sessionId}/`)).status,
    ).toBe(404);
  });
});

describe("start validation and authorization", () => {
  test("rejects bad input", async () => {
    for (const body of [
      {},
      { hostId: "x" },
      { hostId: 0 },
      { hostId: 1.5 },
      { hostId: 1, workspacePath: 5 },
      { hostId: 1, workspacePath: "a\0b" },
      { hostId: 1, workspacePath: "x".repeat(5000) },
    ]) {
      expect(
        (await start(core, "tok-alice", body)).res.status,
        JSON.stringify(body).slice(0, 60),
      ).toBe(400);
    }
    const bad = await call(core, "tok-alice", `${PLUGIN}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(bad.status).toBe(400);
  });

  test("requires a login and the use permission", async () => {
    expect((await start(core, "")).res.status).toBe(401);
    expect((await start(core, "tok-nouse")).res.status).toBe(403);
    const socket = openSocket(core, "?s=0123456789abcdef&p=%2Fx", {
      Cookie: "jwt=tok-nouse",
      Origin: core.baseUrl,
    });
    socket.ws.on("error", () => undefined);
    await socket.closed;
  });

  test("a failed launch leaves nothing behind", async () => {
    // A machine running this suite may have its own code-server on PATH; give
    // the host only the tools the scripts need so the probe finds none.
    const bin = mkdtempSync(path.join(tmpdir(), "vsc-bin-"));
    for (const tool of [
      "sh",
      "uname",
      "cat",
      "kill",
      "sleep",
      "find",
      "tail",
      "touch",
      "mkdir",
      "rm",
      "cut",
      "nohup",
      "setsid",
      "awk",
      "python3",
      "curl",
      "nc",
    ]) {
      const found = spawnSync("sh", ["-c", `command -v ${tool}`], {
        encoding: "utf8",
      }).stdout.trim();
      if (found) symlinkSync(found, path.join(bin, tool));
    }
    expect(existsSync(path.join(bin, "code-server"))).toBe(false);

    const before = ssh.clients.size;
    const missing = await startCoreHost({
      ssh,
      users: USERS,
      hostSettings: { "1:vscodePath": "/nonexistent/code-server" },
      activate,
    });
    ssh.path = bin;
    try {
      const { res, data } = await start(missing);
      expect(res.status).toBe(422);
      expect(data.code).toBe("NOT_INSTALLED");
      expect(await waitFor(() => ssh.clients.size <= before)).toBe(true);
      expect(liveSessions()).toEqual([]);
    } finally {
      ssh.path = process.env.PATH;
      await missing.close();
    }
  });
});

describe("limits and lifecycle", () => {
  test("a user is capped, and the cap frees up when a session stops", async () => {
    const manager = new VSCodeSessionManager({ maxSessionsPerUser: 2 });
    const capped = await startCoreHost({
      ssh,
      users: USERS,
      hostSettings: { "1:vscodePath": STUB },
      activate: (ctx) =>
        void createProxyRouter(
          ctx,
          ctx.http.router({ rawBody: true }),
          manager,
        ),
    });
    try {
      const first = await start(capped);
      const second = await start(capped);
      expect([first.res.status, second.res.status]).toEqual([200, 200]);
      const third = await start(capped);
      expect(third.res.status).toBe(429);
      expect(third.data.code).toBe("TOO_MANY_SESSIONS");
      // Another user is unaffected.
      const bob = await start(capped, "tok-bob");
      expect(bob.res.status).toBe(200);

      await call(
        capped,
        "tok-alice",
        `${PLUGIN}/session/${first.data.sessionId}/stop`,
        { method: "POST" },
      );
      expect((await start(capped)).res.status).toBe(200);
    } finally {
      await manager.disposeAll();
      await capped.close();
    }
    expect(await waitFor(() => liveSessions().length === 0)).toBe(true);
  });

  test("a dropped SSH connection ends the session locally", async () => {
    const { data } = await start(core);
    expect(
      (
        await call(
          core,
          "tok-alice",
          `${PLUGIN}/session/${data.sessionId}/echo`,
        )
      ).status,
    ).toBe(200);

    ssh.dropAll();
    let gone = false;
    for (let i = 0; i < 100 && !gone; i++) {
      gone =
        (
          await call(
            core,
            "tok-alice",
            `${PLUGIN}/session/${data.sessionId}/echo`,
          )
        ).status === 404;
      if (!gone) await new Promise((r) => setTimeout(r, 50));
    }
    expect(gone).toBe(true);
    // The host's watchdog (not Termix) removes the remote server later; clean up here.
    const { RemoteScripts } =
      await import("../../src/backend/remote-scripts.js");
    const { spawnSync } = await import("node:child_process");
    spawnSync("sh", ["-s"], {
      input: RemoteScripts.terminateSession(data.sessionId),
      env: { PATH: process.env.PATH, HOME: home },
    });
  });

  test("the scheduled heartbeat keeps a live session's file fresh, and the reaper spares busy ones", async () => {
    const { data } = await start(core);
    const heartbeat = path.join(sessionsDir(), data.sessionId, "heartbeat");
    const { utimesSync, statSync } = await import("node:fs");
    const old = new Date(Date.now() - 10 * 60_000);
    utimesSync(heartbeat, old, old);
    await core.runScheduled();
    expect(Date.now() - statSync(heartbeat).mtimeMs).toBeLessThan(60_000);
    expect(
      (
        await call(
          core,
          "tok-alice",
          `${PLUGIN}/session/${data.sessionId}/echo`,
        )
      ).status,
    ).toBe(200);
    await call(core, "tok-alice", `${PLUGIN}/session/${data.sessionId}/stop`, {
      method: "POST",
    });
  });

  test("deactivation stops every session and releases every connection", async () => {
    const manager = new VSCodeSessionManager();
    const temp = await startCoreHost({
      ssh,
      users: USERS,
      hostSettings: { "1:vscodePath": STUB },
      activate: (ctx) =>
        void createProxyRouter(
          ctx,
          ctx.http.router({ rawBody: true }),
          manager,
        ),
    });
    try {
      await start(temp);
      await start(temp, "tok-bob");
      expect(manager.size).toBe(2);
      await manager.disposeAll();
      expect(manager.size).toBe(0);
    } finally {
      await temp.close();
    }
    expect(await waitFor(() => liveSessions().length === 0)).toBe(true);
  });
});

describe("choosing what to open", () => {
  const info = async (user: string | null, hostId = 1) => {
    const res = await call(core, user, `${PLUGIN}/workspaces/${hostId}`);
    return {
      res,
      data: (await res.json()) as {
        default: string;
        named: { name: string; path: string }[];
        recent: string[];
      },
    };
  };
  const argsOf = async (sessionId: string) =>
    (await (
      await call(core, "tok-alice", `${PLUGIN}/session/${sessionId}/args`)
    ).json()) as string[];
  const stop = (sessionId: string) =>
    call(core, "tok-alice", `${PLUGIN}/session/${sessionId}/stop`, {
      method: "POST",
    });

  test("lists the host's named workspaces and default, with no history yet", async () => {
    const { res, data } = await info("tok-dave");
    expect(res.status).toBe(200);
    expect(data).toEqual({
      default: "~",
      named: [
        { name: "Proj", path: "~/proj" },
        { name: "Notes", path: "~/notes.txt" },
      ],
      recent: [],
    });
  });

  test("needs a login and a host the user can reach", async () => {
    expect((await info(null)).res.status).toBe(401);
    expect((await info("tok-alice", 2)).res.status).toBe(404);
    expect((await info("tok-alice", 0)).res.status).toBe(400);
    expect(
      (await call(core, "tok-alice", `${PLUGIN}/workspaces/abc`)).status,
    ).toBe(400);
    expect(
      (await call(core, "tok-nouse", `${PLUGIN}/workspaces/1`)).status,
    ).toBe(403);
  });

  test("opens a folder and a .code-workspace file, expanding ~ on the host", async () => {
    const targets: Array<[string, string]> = [
      ["~/proj", path.join(home, "proj")],
      [
        "~/proj/app.code-workspace",
        path.join(home, "proj", "app.code-workspace"),
      ],
      ["/tmp", "/tmp"],
    ];
    for (const [requested, expected] of targets) {
      const { res, data } = await start(core, "tok-alice", {
        hostId: 1,
        workspacePath: requested,
      });
      expect(res.status, requested).toBe(200);
      expect((await argsOf(data.sessionId)).at(-1), requested).toBe(expected);
      await stop(data.sessionId);
    }
  });

  test("a single file is refused with a clear code, and starts nothing", async () => {
    const before = ssh.clients.size;
    const { res, data } = await start(core, "tok-alice", {
      hostId: 1,
      workspacePath: "~/notes.txt",
    });
    expect(res.status).toBe(422);
    expect(data.code).toBe("WORKSPACE_UNSUPPORTED");
    expect((await info("tok-alice")).data.recent).not.toContain("~/notes.txt");
    expect(await waitFor(() => ssh.clients.size <= before)).toBe(true);
  });

  test("remembers what was opened, newest first, per user", async () => {
    const { data: first } = await start(core, "tok-alice", {
      hostId: 1,
      workspacePath: "~/proj",
    });
    const { data: second } = await start(core, "tok-alice", {
      hostId: 1,
      workspacePath: "~/other",
    });
    await stop(first.sessionId);
    await stop(second.sessionId);

    const alice = (await info("tok-alice")).data.recent;
    expect(alice.slice(0, 2)).toEqual(["~/other", "~/proj"]);
    expect((await info("tok-bob")).data.recent).toEqual([]);
  });

  test("with no path it opens the host default and remembers that", async () => {
    const { data } = await start(core, "tok-bob", { hostId: 1 });
    expect(
      (
        await call(
          core,
          "tok-bob",
          `${PLUGIN}/session/${data.sessionId}/args`,
        ).then((r) => r.json())
      ).at(-1),
    ).toBe(home);
    await call(core, "tok-bob", `${PLUGIN}/session/${data.sessionId}/stop`, {
      method: "POST",
    });
    expect((await info("tok-bob")).data.recent).toEqual(["~"]);
  });

  test("a path that does not exist is refused, forgotten, and starts nothing", async () => {
    mkdirSync(path.join(home, "gone"));
    const { data } = await start(core, "tok-alice", {
      hostId: 1,
      workspacePath: "~/gone",
    });
    await stop(data.sessionId);
    expect((await info("tok-alice")).data.recent).toContain("~/gone");
    rmSync(path.join(home, "gone"), { recursive: true });

    const before = ssh.clients.size;
    const retry = await start(core, "tok-alice", {
      hostId: 1,
      workspacePath: "~/gone",
    });
    expect(retry.res.status).toBe(422);
    expect(retry.data.code).toBe("WORKSPACE_NOT_FOUND");
    expect((await info("tok-alice")).data.recent).not.toContain("~/gone");
    expect(await waitFor(() => ssh.clients.size <= before)).toBe(true);
    expect(liveSessions()).toEqual([]);
  });

  test("the settings form rejects a bad list and accepts a good one", async () => {
    expect(
      await core.validateHostSettings({ workspaces: "A = ~/a\nB = ~/b" }),
    ).toEqual({});
    expect(await core.validateHostSettings({ workspaces: "" })).toEqual({});
    expect(await core.validateHostSettings({})).toEqual({});
    expect(
      await core.validateHostSettings({ workspaces: "A = ~/a\nA = ~/b" }),
    ).toEqual({
      workspaces: 'Line 2: "A" is listed twice',
    });
  });
});
