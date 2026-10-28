// A stand-in for code-server: same CLI surface the launch script uses, and the
// behaviours the proxy has to cope with (page, redirects, cookies, gzip, an
// Origin check on sockets, relative WebSocket URLs).
import http from "node:http";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import zlib from "node:zlib";
import { WebSocketServer } from "ws";

const args = process.argv.slice(2);
const bind = args[args.indexOf("--bind-addr") + 1];
const [host, port] = bind.split(":");

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>stub</title></head><body>
<script>
  var ws = new WebSocket(new URL("./stable-abc/socket?token=1&q=%2F", location.href).href.replace(/^http/, "ws"));
  ws.onopen = function () { ws.send("hello"); };
  ws.onmessage = function (event) { document.title = "ws:" + event.data; };
  ws.onerror = function () { document.title = "ws-error"; };
</script></body></html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://stub");
  if (url.pathname === "/redirect") {
    res.writeHead(302, { Location: "/landing" }).end();
  } else if (url.pathname === "/rel") {
    res.writeHead(302, { Location: "./landed?x=1" }).end();
  } else if (url.pathname === "/echo") {
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        headers: req.headers,
        method: req.method,
        url: req.url,
      }),
    );
  } else if (url.pathname === "/args") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(args));
  } else if (url.pathname === "/upload") {
    let size = 0;
    req.on("data", (chunk) => (size += chunk.length));
    req.on("end", () => res.end(String(size)));
  } else if (url.pathname === "/asset.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end("// asset");
  } else {
    const body = Buffer.from(PAGE);
    const headers = {
      "Content-Type": "text/html; charset=utf-8",
      "Set-Cookie": "stub=1; Path=/; HttpOnly",
    };
    if (String(req.headers["accept-encoding"] ?? "").includes("gzip")) {
      headers["Content-Encoding"] = "gzip";
      res.writeHead(200, headers).end(zlib.gzipSync(body));
    } else {
      res.writeHead(200, headers).end(body);
    }
  }
});

const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  // code-server refuses a socket whose Origin is not the Host it was sent.
  const origin = req.headers.origin ? new URL(req.headers.origin).host : "";
  if (origin && origin !== req.headers.host) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws.send(`path:${req.url}`);
    ws.send(
      `seen:${JSON.stringify({ cookie: req.headers.cookie ?? null, protocol: req.headers["sec-websocket-protocol"] ?? null })}`,
    );
    ws.on("message", (data) => ws.send(`echo:${data}`));
  });
});

// Like code-server's extension host: a child in the same process group that
// ignores SIGTERM, so only a group-wide SIGKILL gets rid of it.
const child = spawn("sh", ["-c", "trap '' TERM; exec sleep 300"], {
  stdio: "ignore",
});
writeFileSync(`${process.env.HOME}/child-${port}.pid`, String(child.pid));

server.listen(Number(port), host);
process.on("SIGTERM", () => process.exit(0));
