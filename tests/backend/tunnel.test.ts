import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import type { AddressInfo } from "node:net";
import { afterAll as after, beforeAll as before, test } from "vitest";
import httpProxy from "http-proxy";
import ssh2 from "ssh2";
import { WebSocketServer } from "ws";
import { VSCodeSessionManager } from "../../src/backend/session-manager.js";
import { createTunnelAgent } from "../../src/backend/tunnel-bridge.js";

const { Client, Server, utils } = ssh2;

let sshServer: InstanceType<typeof Server>;
let target: http.Server;
let wss: WebSocketServer;
let sshClient: InstanceType<typeof Client>;
let proxyServer: http.Server;
let channelsOpened = 0;
const proxy = httpProxy.createProxyServer({
  ws: true,
  xfwd: true,
  changeOrigin: false,
});
proxy.on("error", () => undefined);

const listen = (server: net.Server) =>
  new Promise<number>((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );

let targetPort = 0;
let proxyPort = 0;

before(async () => {
  target = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/plain");
    res.end(
      `host=${req.headers.host};url=${req.url};cookie=${req.headers.cookie ?? ""}`,
    );
  });
  wss = new WebSocketServer({ server: target });
  wss.on("connection", (socket) =>
    socket.on("message", (data) => socket.send(`echo:${data}`)),
  );
  targetPort = await listen(target);

  const { private: hostKey } = utils.generateKeyPairSync("ed25519");
  sshServer = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("authentication", (ctx) => ctx.accept());
    client.on("ready", () => {
      client.on("tcpip", (accept, reject, info) => {
        const upstream = net.connect(info.destPort, "127.0.0.1");
        upstream.once("connect", () => {
          channelsOpened++;
          const channel = accept();
          channel.pipe(upstream).pipe(channel);
          channel.on("error", () => upstream.destroy());
        });
        upstream.once("error", () => reject());
      });
    });
    client.on("error", () => undefined);
  });
  const sshPort = await listen(sshServer);

  sshClient = new Client();
  await new Promise<void>((resolve, reject) => {
    sshClient.once("ready", resolve).once("error", reject);
    sshClient.connect({
      host: "127.0.0.1",
      port: sshPort,
      username: "u",
      password: "p",
    });
  });

  const agent = createTunnelAgent(sshClient, targetPort);
  const opts = { target: `http://127.0.0.1:${targetPort}`, agent };
  proxyServer = http.createServer((req, res) => proxy.web(req, res, opts));
  proxyServer.on("upgrade", (req, socket, head) =>
    proxy.ws(req, socket, head, opts),
  );
  proxyPort = await listen(proxyServer);
});

after(() => {
  sshClient.end();
  for (const server of [proxyServer, target, sshServer]) server.close();
  wss.close();
});

test("HTTP reaches the remote port through an SSH channel and keeps the Host header", async () => {
  const before = channelsOpened;
  const res = await fetch(`http://127.0.0.1:${proxyPort}/some/path?x=1`);
  assert.equal(res.status, 200);
  assert.equal(
    await res.text(),
    `host=127.0.0.1:${proxyPort};url=/some/path?x=1;cookie=`,
  );
  assert.ok(
    channelsOpened > before,
    "request should open a direct-tcpip channel",
  );
});

test("WebSocket upgrades and echoes through the tunnel", async () => {
  const ws = new WebSocket(`ws://127.0.0.1:${proxyPort}/socket`);
  const reply = await new Promise<string>((resolve, reject) => {
    ws.onopen = () => ws.send("ping");
    ws.onmessage = (event) => resolve(String(event.data));
    ws.onerror = () => reject(new Error("websocket failed"));
  });
  ws.close();
  assert.equal(reply, "echo:ping");
});

test("a closed target yields a proxy error, not a crash", async () => {
  const dead = net.createServer();
  const port = await listen(dead);
  await new Promise((r) => dead.close(r));
  const agent = createTunnelAgent(sshClient, port);
  const srv = http.createServer((req, res) =>
    proxy.web(req, res, { target: `http://127.0.0.1:${port}`, agent }, () => {
      res.statusCode = 502;
      res.end("bad gateway");
    }),
  );
  const srvPort = await listen(srv);
  const res = await fetch(`http://127.0.0.1:${srvPort}/`);
  srv.close();
  assert.equal(res.status, 502);
});

test("session manager enforces ownership and releases the SSH connection on stop", async () => {
  const manager = new VSCodeSessionManager();
  let disconnected = 0;
  const fakeAgent = {
    killSession: async () => undefined,
    launchSession: async () => ({
      sessionId: "0123456789abcdef",
      port: targetPort,
      pid: 1,
    }),
  };
  // Swap in a launch that skips the remote shell; everything else is real.
  const mod = await import("../../src/backend/remote-agent.js");
  const original = mod.RemoteVSCodeAgent.prototype;
  const saved = { launch: original.launchSession, kill: original.killSession };
  original.launchSession = fakeAgent.launchSession;
  original.killSession = fakeAgent.killSession;
  try {
    const session = await manager.startSession({
      client: sshClient,
      disconnect: () => void disconnected++,
      hostId: 7,
      ownerId: "alice",
    });
    assert.equal(manager.getSessionFor(session.sessionId, "alice"), session);
    assert.equal(manager.getSessionFor(session.sessionId, "bob"), undefined);
    assert.equal(
      manager.getSessionFor(session.sessionId, undefined),
      undefined,
    );

    await manager.stopSession(session.sessionId);
    assert.equal(disconnected, 1);
    assert.equal(manager.getSessionFor(session.sessionId, "alice"), undefined);
    await manager.stopSession(session.sessionId); // idempotent
    assert.equal(disconnected, 1);
  } finally {
    original.launchSession = saved.launch;
    original.killSession = saved.kill;
  }
});

test("a failed launch releases the SSH connection", async () => {
  const manager = new VSCodeSessionManager();
  let disconnected = 0;
  const original = (await import("../../src/backend/remote-agent.js"))
    .RemoteVSCodeAgent.prototype;
  const saved = original.launchSession;
  original.launchSession = async () => {
    throw new Error("ERR_CODE_SERVER_NOT_INSTALLED");
  };
  try {
    await assert.rejects(
      manager.startSession({
        client: sshClient,
        disconnect: () => void disconnected++,
        hostId: 1,
        ownerId: "a",
      }),
      /NOT_INSTALLED/,
    );
    assert.equal(disconnected, 1);
  } finally {
    original.launchSession = saved;
  }
});
