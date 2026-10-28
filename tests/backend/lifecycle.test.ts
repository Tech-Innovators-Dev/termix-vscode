import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test, vi } from "vitest";
import { RemoteVSCodeAgent } from "../../src/backend/remote-agent.js";
import { RemoteScripts } from "../../src/backend/remote-scripts.js";
import { VSCodeSessionManager } from "../../src/backend/session-manager.js";

const STUB = path.resolve(import.meta.dirname, "support/stub-code-server");
const SESSION = "fedcba9876543210";

afterEach(() => vi.restoreAllMocks());

function fakeClient() {
  const handlers: Record<string, () => void> = {};
  return {
    once: (event: string, handler: () => void) =>
      void (handlers[event] = handler),
    emit: (event: string) => handlers[event]?.(),
    forwardOut: vi.fn(),
  };
}

async function sessionWith(
  manager: VSCodeSessionManager,
  ownerId: string,
  client = fakeClient(),
) {
  let n = 0;
  vi.spyOn(RemoteVSCodeAgent.prototype, "launchSession").mockImplementation(
    async () => ({
      sessionId: (++n + Math.floor(Math.random() * 1e9))
        .toString(16)
        .padStart(16, "0"),
      port: 1,
      pid: 1,
    }),
  );
  const kill = vi
    .spyOn(RemoteVSCodeAgent.prototype, "killSession")
    .mockResolvedValue();
  const disconnect = vi.fn();
  const session = await manager.startSession({
    client: client as never,
    disconnect,
    hostId: 1,
    ownerId,
  });
  return { session, disconnect, kill, client };
}

describe("idle reaping", () => {
  test("stops sessions idle past the limit, but not busy or recently used ones", async () => {
    let now = 1_000_000;
    const manager = new VSCodeSessionManager({ now: () => now });
    const idle = await sessionWith(manager, "a");
    const busy = await sessionWith(manager, "a");
    const recent = await sessionWith(manager, "a");

    const socket = new PassThrough();
    manager.trackSocket(busy.session, socket);

    now += 10 * 60_000;
    manager.touch(recent.session);
    now += 6 * 60_000;

    const reaped = await manager.reapIdle(15 * 60_000);
    expect(reaped).toEqual([idle.session.sessionId]);
    expect(idle.disconnect).toHaveBeenCalledOnce();
    expect(manager.getSessionFor(busy.session.sessionId, "a")).toBeDefined();
    expect(manager.getSessionFor(recent.session.sessionId, "a")).toBeDefined();

    // Closing the last socket starts the idle clock from that moment.
    socket.destroy();
    await new Promise((r) => setImmediate(r));
    now += 14 * 60_000;
    expect(await manager.reapIdle(15 * 60_000)).toEqual([
      recent.session.sessionId,
    ]);
    now += 2 * 60_000;
    expect(await manager.reapIdle(15 * 60_000)).toEqual([
      busy.session.sessionId,
    ]);
    expect(manager.size).toBe(0);
  });
});

describe("connection loss and heartbeats", () => {
  test("an SSH close releases the session, its sockets and its connection exactly once", async () => {
    const manager = new VSCodeSessionManager();
    const { session, disconnect, client, kill } = await sessionWith(
      manager,
      "a",
    );
    const socket = new PassThrough();
    manager.trackSocket(session, socket);

    client.emit("close");
    expect(manager.size).toBe(0);
    expect(socket.destroyed).toBe(true);
    expect(disconnect).toHaveBeenCalledOnce();
    // No remote command can run over a dead connection; the host's watchdog does it.
    expect(kill).not.toHaveBeenCalled();

    await manager.stopSession(session.sessionId);
    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("a stop followed by the resulting close does not double-release", async () => {
    const manager = new VSCodeSessionManager();
    const { session, disconnect, client } = await sessionWith(manager, "a");
    await manager.stopSession(session.sessionId);
    client.emit("close");
    expect(disconnect).toHaveBeenCalledOnce();
  });

  test("a host that reports the session gone ends it; a failing heartbeat does not", async () => {
    const manager = new VSCodeSessionManager();
    const gone = await sessionWith(manager, "a");
    const flaky = await sessionWith(manager, "a");
    vi.spyOn(RemoteVSCodeAgent.prototype, "heartbeat").mockImplementation(
      async (id) => {
        if (id === gone.session.sessionId) return false;
        throw new Error("channel closed");
      },
    );
    await manager.heartbeatAll();
    expect(manager.getSessionFor(gone.session.sessionId, "a")).toBeUndefined();
    expect(manager.getSessionFor(flaky.session.sessionId, "a")).toBeDefined();
  });

  test("the cap counts sessions still launching, so a burst cannot exceed it", async () => {
    const manager = new VSCodeSessionManager({ maxSessionsPerUser: 2 });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let n = 0;
    vi.spyOn(RemoteVSCodeAgent.prototype, "launchSession").mockImplementation(
      async () => {
        await gate;
        return {
          sessionId: (++n).toString(16).padStart(16, "0"),
          port: 1,
          pid: 1,
        };
      },
    );
    const disconnects = [vi.fn(), vi.fn(), vi.fn()];
    const attempts = disconnects.map((disconnect) =>
      manager.startSession({
        client: fakeClient() as never,
        disconnect,
        hostId: 1,
        ownerId: "a",
      }),
    );
    release();
    const results = await Promise.allSettled(attempts);
    expect(results.map((r) => r.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "rejected",
    ]);
    expect(disconnects[2]).toHaveBeenCalledOnce();
  });
});

describe("the host-side watchdog", () => {
  const sh = (script: string, home: string) =>
    spawnSync("sh", ["-s"], {
      input: script,
      env: { PATH: process.env.PATH, HOME: home },
      encoding: "utf8",
    });
  const alive = (pid: string) => spawnSync("kill", ["-0", pid]).status === 0;
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** The SIGTERM-ignoring child the stub starts in the server's process group. */
  async function childOf(home: string) {
    for (
      let i = 0;
      i < 50 && !readdirSync(home).some((f) => f.startsWith("child-"));
      i++
    )
      await sleep(100);
    return readFileSync(
      path.join(
        home,
        readdirSync(home).find((f) => f.startsWith("child-"))!,
      ),
      "utf8",
    );
  }

  async function launch(home: string) {
    const out = sh(
      RemoteScripts.launchCodeServer({
        binaryPath: STUB,
        sessionId: SESSION,
        workspacePath: "~",
        watchdogIntervalSec: 1,
        heartbeatTimeoutMin: 1,
      }),
      home,
    );
    const match = /SPAWNED:(\d+):(\d+)/.exec(out.stdout);
    if (!match) throw new Error(out.stdout + out.stderr);
    return {
      dir: path.join(home, ".termix", "vscode", SESSION),
      pid: match[2],
    };
  }

  test("stops and cleans up a server whose heartbeat went quiet, and spares a fresh one", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vsc-wd-"));
    const { dir, pid } = await launch(home);
    const child = await childOf(home);
    try {
      await sleep(2500);
      expect(alive(pid)).toBe(true); // fresh heartbeat: left alone
      expect(existsSync(dir)).toBe(true);

      const old = new Date(Date.now() - 5 * 60_000);
      utimesSync(path.join(dir, "heartbeat"), old, old);
      for (let i = 0; i < 100 && alive(pid); i++) await sleep(100);
      expect(alive(pid)).toBe(false);
      // The watchdog gives the server two seconds to exit before it removes the directory.
      for (let i = 0; i < 60 && existsSync(dir); i++) await sleep(100);
      expect(existsSync(dir)).toBe(false);
      for (let i = 0; i < 40 && alive(child); i++) await sleep(100);
      expect(alive(child)).toBe(false);
    } finally {
      sh(RemoteScripts.terminateSession(SESSION), home);
    }
  }, 30_000);

  test("terminate stops the server and the watchdog exits with it", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "vsc-wd2-"));
    const { pid } = await launch(home);
    const child = await childOf(home);
    expect(alive(child)).toBe(true);
    sh(RemoteScripts.terminateSession(SESSION), home);
    for (let i = 0; i < 50 && alive(pid); i++) await sleep(100);
    expect(alive(pid)).toBe(false);
    // The whole process group goes, including a child that ignores SIGTERM.
    for (let i = 0; i < 20 && alive(child); i++) await sleep(100);
    expect(alive(child)).toBe(false);
    // Terminate stops the watchdog along with the server, without waiting for its next tick.
    const watchers = () =>
      spawnSync("pgrep", ["-f", `${home}/.termix/vscode/${SESSION}`], {
        encoding: "utf8",
      }).stdout.trim();
    for (let i = 0; i < 15 && watchers(); i++) await sleep(100);
    expect(watchers()).toBe("");
  }, 30_000);
});
