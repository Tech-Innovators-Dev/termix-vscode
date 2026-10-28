import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import {
  RemoteScripts,
  isSessionId,
  shQuote,
} from "../../src/backend/remote-scripts.js";

const SESSION = "0123456789abcdef";

function runSh(script: string, home: string) {
  return spawnSync("sh", ["-s"], {
    input: script,
    env: { PATH: process.env.PATH, HOME: home },
    encoding: "utf8",
  });
}

async function waitFor(file: string) {
  for (let i = 0; i < 50 && !existsSync(file); i++)
    await new Promise((r) => setTimeout(r, 100));
}

test("shQuote survives a round trip through sh", () => {
  for (const value of [
    "plain",
    "it's",
    "a b",
    "$(touch x)",
    "`touch x`",
    "; touch x",
    "line\nbreak",
    "",
  ]) {
    const out = spawnSync("sh", ["-c", `printf %s ${shQuote(value)}`], {
      encoding: "utf8",
    });
    assert.equal(out.stdout, value);
  }
});

test("session ids must be 16 hex characters", () => {
  assert.ok(isSessionId(SESSION));
  for (const bad of [
    "",
    "../etc",
    `${SESSION}; id`,
    SESSION.toUpperCase(),
    42,
    undefined,
  ]) {
    assert.equal(isSessionId(bad), false);
  }
  assert.throws(() => RemoteScripts.terminateSession("../../etc"));
  assert.throws(() =>
    RemoteScripts.launchCodeServer({
      binaryPath: "x",
      sessionId: "bad",
      workspacePath: "~",
    }),
  );
  assert.throws(() => RemoteScripts.checkReadiness(SESSION, 0));
});

test("probe does not execute a hostile custom path", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vsc-probe-"));
  const marker = path.join(home, "pwned");
  const result = runSh(
    RemoteScripts.probeEnvironment(`x'; touch ${marker}; '`),
    home,
  );
  assert.equal(existsSync(marker), false);
  assert.match(result.stdout, /^OS:/m);
});

test("launch and terminate treat paths as data", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "vsc-launch-"));
  const marker = path.join(home, "pwned");
  const bin = path.join(home, "it's a stub");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/args.txt"\nexec sleep 30\n`,
  );
  chmodSync(bin, 0o755);

  // The workspace must exist on the host; give it the hostile-looking name.
  mkdirSync(`${home}/proj'; touch ${marker}; '`, { recursive: true });

  const launch = runSh(
    RemoteScripts.launchCodeServer({
      binaryPath: bin,
      sessionId: SESSION,
      workspacePath: `~/proj'; touch ${marker}; '`,
    }),
    home,
  );
  const match = /SPAWNED:(\d+):(\d+)/.exec(launch.stdout);
  assert.ok(match, `unexpected output: ${launch.stdout}${launch.stderr}`);

  await waitFor(path.join(home, "args.txt"));
  const args = readFileSync(path.join(home, "args.txt"), "utf8")
    .trimEnd()
    .split("\n");
  assert.equal(args.at(-1), `${home}/proj'; touch ${marker}; '`);
  assert.ok(args.includes("--auth") && args.includes("none"));
  // Each session has its own data directory (code-server would otherwise hand a
  // second launch to a running instance), sharing settings and extensions.
  const dataDir = args[args.indexOf("--user-data-dir") + 1];
  assert.equal(dataDir, `${home}/.termix/vscode/${SESSION}/data`);
  assert.ok(args.includes("--ignore-last-opened"));
  assert.equal(
    args[args.indexOf("--extensions-dir") + 1],
    `${home}/.local/share/code-server/extensions`,
  );
  assert.equal(
    readlinkSync(`${dataDir}/User`),
    `${home}/.local/share/code-server/User`,
  );
  assert.equal(existsSync(marker), false);

  const stop = runSh(RemoteScripts.terminateSession(SESSION), home);
  assert.match(stop.stdout, /TERMINATED/);
  assert.equal(
    existsSync(path.join(home, ".termix", "vscode", SESSION)),
    false,
  );
  assert.equal(
    spawnSync("kill", ["-0", match[2]]).status !== 0,
    true,
    "stub should be gone",
  );
});

test("readiness reports a dead server with its log", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vsc-ready-"));
  const dir = path.join(home, ".termix", "vscode", SESSION);
  spawnSync("mkdir", ["-p", dir]);
  writeFileSync(path.join(dir, "server.pid"), "999999\n");
  writeFileSync(path.join(dir, "server.log"), "boom: address in use\n");
  const result = runSh(RemoteScripts.checkReadiness(SESSION, 4000), home);
  assert.match(result.stdout, /^DIED/);
  assert.match(result.stdout, /boom: address in use/);
});

test("a workspace that is not on the host stops the launch before anything starts", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vsc-nows-"));
  const result = runSh(
    RemoteScripts.launchCodeServer({
      binaryPath: "/bin/true",
      sessionId: SESSION,
      workspacePath: "~/missing",
    }),
    home,
  );
  expect(result.status).toBe(3);
  expect(result.stdout.trim()).toBe("NO_WORKSPACE");
  expect(existsSync(path.join(home, ".termix"))).toBe(false);
});

test("XDG_DATA_HOME decides where the shared settings live", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vsc-xdg-"));
  const xdg = mkdtempSync(path.join(tmpdir(), "vsc-xdgdata-"));
  const bin = path.join(home, "stub");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '%s\\n' "$@" > "${home}/args.txt"\nexec sleep 30\n`,
  );
  chmodSync(bin, 0o755);
  const result = spawnSync("sh", ["-s"], {
    input: RemoteScripts.launchCodeServer({
      binaryPath: bin,
      sessionId: SESSION,
      workspacePath: "~",
    }),
    env: { PATH: process.env.PATH, HOME: home, XDG_DATA_HOME: xdg },
    encoding: "utf8",
  });
  assert.match(result.stdout, /SPAWNED/);
  assert.equal(existsSync(`${xdg}/code-server/User`), true);
  assert.equal(existsSync(`${home}/.local`), false);
  spawnSync("sh", ["-s"], {
    input: RemoteScripts.terminateSession(SESSION),
    env: { PATH: process.env.PATH, HOME: home },
  });
});

test("a plain file is refused (code-server would open an empty window), a .code-workspace file is not", () => {
  const home = mkdtempSync(path.join(tmpdir(), "vsc-file-"));
  writeFileSync(path.join(home, "notes.txt"), "x");
  const refused = runSh(
    RemoteScripts.launchCodeServer({
      binaryPath: "/bin/true",
      sessionId: SESSION,
      workspacePath: "~/notes.txt",
    }),
    home,
  );
  expect(refused.status).toBe(4);
  expect(refused.stdout.trim()).toBe("UNSUPPORTED_FILE");
  expect(existsSync(path.join(home, ".termix"))).toBe(false);

  writeFileSync(path.join(home, "a.code-workspace"), "{}");
  const accepted = runSh(
    RemoteScripts.launchCodeServer({
      binaryPath: "/bin/true",
      sessionId: SESSION,
      workspacePath: "~/a.code-workspace",
    }),
    home,
  );
  expect(accepted.stdout).toMatch(/SPAWNED/);
});
