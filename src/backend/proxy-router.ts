import type { IncomingMessage, ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import type { Router } from "express";
import httpProxy from "http-proxy";
import type { Client } from "ssh2";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { isSessionId } from "./remote-scripts.js";
import { WorkspaceHistory } from "./history.js";
import { parseWorkspaces, pathProblem } from "../shared/workspaces.js";
import { ERR_TOO_MANY_SESSIONS } from "./session-manager.js";
import type { ActiveSession, VSCodeSessionManager } from "./session-manager.js";
import {
  WS_ROUTE,
  WS_SHIM_PATH,
  WS_SHIM_SOURCE,
  injectShim,
} from "./ws-shim.js";

const MAX_START_BODY_BYTES = 16 * 1024;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const JWT_SUBPROTOCOL_PREFIX = "termix.jwt.";

/** The router skips body parsing so proxied request bodies stay streamable. */
function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_START_BODY_BYTES) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const parsed: unknown = JSON.parse(
          Buffer.concat(chunks).toString("utf8") || "{}",
        );
        resolve(
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {},
        );
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

/** Termix's own credentials stop here; the remote daemon never sees them. */
function stripCredentials(req: IncomingMessage): void {
  delete req.headers.cookie;
  delete req.headers.authorization;

  const protocols = req.headers["sec-websocket-protocol"];
  if (typeof protocols === "string") {
    const kept = protocols
      .split(",")
      .map((protocol) => protocol.trim())
      .filter(
        (protocol) => protocol && !protocol.startsWith(JWT_SUBPROTOCOL_PREFIX),
      );
    if (kept.length > 0)
      req.headers["sec-websocket-protocol"] = kept.join(", ");
    else delete req.headers["sec-websocket-protocol"];
  }
}

/** The page itself, as opposed to one of its scripts, images or fetches. */
function isDocumentRequest(req: IncomingMessage, path: string): boolean {
  if (req.method !== "GET" || path !== "/") return false;
  const dest = req.headers["sec-fetch-dest"];
  if (dest) return dest === "document" || dest === "iframe";
  return String(req.headers.accept ?? "").includes("text/html");
}

function scopeCookie(cookie: string, base: string): string {
  return /;\s*path=/i.test(cookie)
    ? cookie.replace(/;\s*path=[^;]*/i, `; Path=${base}/`)
    : `${cookie}; Path=${base}/`;
}

/**
 * Relays a response http-proxy handed over, with the rewrites its own
 * response pipeline would have done, and the shim added to the page.
 */
function relayDocument(
  proxyRes: IncomingMessage,
  res: ServerResponse,
  base: string,
  remotePort: number,
): void {
  const headers: Record<string, string | string[] | undefined> = {
    ...proxyRes.headers,
  };

  const location = headers.location;
  if (typeof location === "string") {
    if (location.startsWith("/") && !location.startsWith("//"))
      headers.location = `${base}${location}`;
    else
      headers.location = location.replace(
        new RegExp(`^https?://127\\.0\\.0\\.1:${remotePort}`),
        base,
      );
  }
  const cookies = proxyRes.headers["set-cookie"];
  if (cookies)
    headers["set-cookie"] = cookies.map((cookie) => scopeCookie(cookie, base));

  const isHtml = /^text\/html/i.test(String(headers["content-type"] ?? ""));
  const encoded =
    headers["content-encoding"] && headers["content-encoding"] !== "identity";
  if (!isHtml || encoded || proxyRes.statusCode !== 200) {
    res.writeHead(proxyRes.statusCode ?? 502, headers);
    proxyRes.pipe(res);
    return;
  }

  const chunks: Buffer[] = [];
  let size = 0;
  proxyRes.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > MAX_HTML_BYTES) {
      proxyRes.destroy();
      if (!res.headersSent) res.writeHead(502);
      res.end();
      return;
    }
    chunks.push(chunk);
  });
  proxyRes.on("end", () => {
    if (res.writableEnded) return;
    const body = Buffer.from(
      injectShim(Buffer.concat(chunks).toString("utf8")),
      "utf8",
    );
    headers["content-length"] = String(body.length);
    delete headers["transfer-encoding"];
    res.writeHead(200, headers);
    res.end(body);
  });
  proxyRes.on("error", () => res.destroy());
}

export function createProxyRouter(
  ctx: PluginContext,
  router: Router,
  sessionManager: VSCodeSessionManager,
  history: WorkspaceHistory = new WorkspaceHistory(ctx),
) {
  // changeOrigin stays off: code-server compares the Origin of a WebSocket
  // with the Host it was sent, and the browser's Origin is Termix's.
  const proxy = httpProxy.createProxyServer({
    ws: true,
    xfwd: true,
    changeOrigin: false,
  });

  proxy.on("error", (err, _req, res) => {
    ctx.log.warn(`vscode proxy error: ${err.message}`);
    if (res && "writeHead" in res && typeof res.writeHead === "function") {
      if (!res.headersSent)
        res.writeHead(502, { "Content-Type": "text/plain" });
      res.end("Tunnel offline or connection reset.");
    } else if (res && "destroy" in res && typeof res.destroy === "function") {
      res.destroy();
    }
  });

  proxy.on("proxyRes", (proxyRes, req, res) => {
    const meta = (
      req as IncomingMessage & { termix?: { base: string; remotePort: number } }
    ).termix;
    // Only requests sent with selfHandleResponse carry the meta.
    if (meta)
      relayDocument(
        proxyRes,
        res as ServerResponse,
        meta.base,
        meta.remotePort,
      );
  });

  router.use(ctx.rbac.require("use") as never);

  const target = (session: ActiveSession) => ({
    target: `http://127.0.0.1:${session.remotePort}`,
    agent: session.tunnelAgent,
  });

  /**
   * @openapi
   * /plugin-api/termix-vscode/session/start:
   *   post:
   *     summary: Start a code-server session on a host over SSH
   *     tags:
   *       - VS Code
   *     requestBody:
   *       required: true
   *       content:
   *         application/json:
   *           schema:
   *             type: object
   *             properties:
   *               hostId:
   *                 type: integer
   *               workspacePath:
   *                 type: string
   *     responses:
   *       200:
   *         description: Session started
   *       400:
   *         description: Missing or invalid hostId or workspacePath
   *       422:
   *         description: code-server is not installed on the host, or the workspace path does not exist
   *       429:
   *         description: Too many open sessions
   */
  router.post("/session/start", async (req, res) => {
    const ownerId = ctx.currentActor();
    if (!ownerId) return res.status(401).json({ error: "Not signed in" });

    let body: { hostId?: unknown; workspacePath?: unknown };
    try {
      body = await readJsonBody(req as IncomingMessage);
    } catch (err) {
      return res.status(400).json({ error: (err as Error).message });
    }

    const hostId = Number(body.hostId);
    if (!Number.isInteger(hostId) || hostId < 1) {
      return res.status(400).json({ error: "Missing or invalid hostId" });
    }
    const workspace = body.workspacePath;
    if (
      workspace !== undefined &&
      (typeof workspace !== "string" || pathProblem(workspace.trim()))
    ) {
      return res.status(400).json({ error: "Invalid workspacePath" });
    }

    try {
      const [customBinaryPath, defaultWorkspace] = await Promise.all([
        ctx.settings.getHost<string>(hostId, "vscodePath"),
        ctx.settings.getHost<string>(hostId, "defaultWorkspace"),
      ]);

      // connect applies the actor's access to the host.
      const connection = await ctx.ssh.connect<Client>(hostId, {
        purpose: "vscode",
        profile: "session",
      });

      const workspacePath =
        (workspace as string | undefined)?.trim() || defaultWorkspace || "~";
      const session = await sessionManager
        .startSession({
          client: connection.client,
          disconnect: connection.dispose,
          hostId,
          ownerId,
          workspacePath,
          customBinaryPath: customBinaryPath || undefined,
        })
        .catch(async (err: unknown) => {
          // A remembered path that is gone must not be offered again.
          if (
            err instanceof Error &&
            (err.message === "ERR_WORKSPACE_NOT_FOUND" ||
              err.message === "ERR_WORKSPACE_UNSUPPORTED")
          ) {
            await history
              .forget(ownerId, hostId, workspacePath)
              .catch(() => undefined);
          }
          throw err;
        });
      await history
        .record(ownerId, hostId, workspacePath)
        .catch((err: Error) => {
          ctx.log.warn(`vscode workspace history not saved: ${err.message}`);
        });

      return res.json({
        sessionId: session.sessionId,
        iframeUrl: `${ctx.http.baseUrl(req)}/plugin-api/${ctx.pluginId}/session/${session.sessionId}/`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "";
      if (message === "ERR_CODE_SERVER_NOT_INSTALLED") {
        return res.status(422).json({
          code: "NOT_INSTALLED",
          error: "code-server executable not found on target host",
        });
      }
      if (message === "ERR_WORKSPACE_NOT_FOUND") {
        return res.status(422).json({
          code: "WORKSPACE_NOT_FOUND",
          error: "That folder or file does not exist on the host",
        });
      }
      if (message === "ERR_WORKSPACE_UNSUPPORTED") {
        return res.status(422).json({
          code: "WORKSPACE_UNSUPPORTED",
          error: "Open a folder or a .code-workspace file, not a single file",
        });
      }
      if (message === ERR_TOO_MANY_SESSIONS) {
        return res.status(429).json({
          code: "TOO_MANY_SESSIONS",
          error: "Too many open VS Code sessions",
        });
      }
      ctx.log.error(`vscode session start failed: ${message}`);
      return res
        .status(500)
        .json({ error: message || "Failed to start session" });
    }
  });

  /**
   * @openapi
   * /plugin-api/termix-vscode/workspaces/{hostId}:
   *   get:
   *     summary: The workspaces a host offers the signed-in user
   *     description: The host's named workspaces and default, and the paths the user opened on it before, newest first.
   *     tags:
   *       - VS Code
   *     parameters:
   *       - in: path
   *         name: hostId
   *         required: true
   *         schema:
   *           type: integer
   *     responses:
   *       200:
   *         description: Default path, named workspaces and recent paths
   *       400:
   *         description: Invalid hostId
   *       404:
   *         description: The host is not one the user can connect to
   */
  router.get("/workspaces/:hostId", async (req, res) => {
    const ownerId = ctx.currentActor();
    if (!ownerId) return res.status(401).json({ error: "Not signed in" });

    const hostId = Number(req.params.hostId);
    if (!Number.isInteger(hostId) || hostId < 1)
      return res.status(400).json({ error: "Invalid hostId" });

    try {
      if (!(await ctx.ssh.resolveHost(hostId)))
        return res.status(404).json({ error: "Host not found" });
      const [defaultWorkspace, named, recent] = await Promise.all([
        ctx.settings.getHost<string>(hostId, "defaultWorkspace"),
        ctx.settings.getHost<string>(hostId, "workspaces"),
        history.list(ownerId, hostId),
      ]);
      return res.json({
        default: defaultWorkspace || "~",
        named: parseWorkspaces(named).entries,
        recent,
      });
    } catch (err) {
      ctx.log.error(
        `vscode workspaces lookup failed: ${(err as Error).message}`,
      );
      return res.status(500).json({ error: "Failed to load workspaces" });
    }
  });

  /**
   * @openapi
   * /plugin-api/termix-vscode/session/{id}/stop:
   *   post:
   *     summary: Stop a session and its remote code-server
   *     tags:
   *       - VS Code
   *     parameters:
   *       - in: path
   *         name: id
   *         required: true
   *         schema:
   *           type: string
   *     responses:
   *       200:
   *         description: Stopped
   *       404:
   *         description: Not a session of the signed-in user
   */
  router.post("/session/:id/stop", async (req, res) => {
    const { id } = req.params;
    if (
      !isSessionId(id) ||
      !sessionManager.getSessionFor(id, ctx.currentActor())
    ) {
      return res.status(404).json({ error: "Session not found" });
    }
    try {
      await sessionManager.stopSession(id);
    } catch (err) {
      ctx.log.warn(`vscode session stop failed: ${(err as Error).message}`);
    }
    return res.json({ success: true });
  });

  // Everything else under /session/:id is code-server's own web app. Express
  // has already cut the mount point and `/session/:id` off req.url.
  router.use("/session/:id", (req, res) => {
    const { id } = req.params;
    const session = isSessionId(id)
      ? sessionManager.getSessionFor(id, ctx.currentActor())
      : undefined;
    if (!session) {
      res
        .status(404)
        .type("text/plain")
        .send("Session expired or does not exist");
      return;
    }
    sessionManager.touch(session);

    const path = req.url.split("?")[0];

    // code-server's relative URLs need the trailing slash on the base.
    if (path === "/" && !req.originalUrl.split("?")[0].endsWith("/")) {
      const query = req.originalUrl.includes("?")
        ? req.originalUrl.slice(req.originalUrl.indexOf("?"))
        : "";
      res.redirect(301, `${req.baseUrl}/${query}`);
      return;
    }

    if (path === WS_SHIM_PATH) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(WS_SHIM_SOURCE);
      return;
    }

    stripCredentials(req);

    if (isDocumentRequest(req, path)) {
      // The page is rewritten, so it must arrive uncompressed.
      delete req.headers["accept-encoding"];
      (req as IncomingMessage & { termix?: unknown }).termix = {
        base: req.baseUrl,
        remotePort: session.remotePort,
      };
      proxy.web(req as IncomingMessage, res as unknown as ServerResponse, {
        ...target(session),
        selfHandleResponse: true,
      });
      return;
    }

    proxy.web(req as IncomingMessage, res as unknown as ServerResponse, {
      ...target(session),
      cookiePathRewrite: `${req.baseUrl}/`,
    });
  });

  // The page's sockets arrive here through the shim, carrying the session in
  // `s` and the path code-server asked for in `p`. Core authenticated the
  // socket and passes that user as userId.
  ctx.ws.upgrade(WS_ROUTE, async (request, socket, head, userId) => {
    const req = request as IncomingMessage;
    const duplex = socket as Duplex;
    try {
      const query = new URL(req.url ?? "", "http://localhost").searchParams;
      const sessionId = query.get("s");
      const path = query.get("p") ?? "";
      const session = isSessionId(sessionId)
        ? sessionManager.getSessionFor(sessionId, userId)
        : undefined;

      if (
        !session ||
        !path.startsWith("/") ||
        path.startsWith("//") ||
        /[\u0000-\u001f\u007f\s]/.test(path)
      ) {
        duplex.destroy();
        return;
      }
      if (!(await ctx.rbac.hasFor(userId, "use"))) {
        duplex.destroy();
        return;
      }
      // The session may have been stopped while the permission was checked.
      if (!sessionManager.getSessionFor(session.sessionId, userId)) {
        duplex.destroy();
        return;
      }

      req.url = path;
      stripCredentials(req);
      sessionManager.trackSocket(session, duplex);
      proxy.ws(req, duplex, head as Buffer, target(session));
    } catch (err) {
      ctx.log.warn(
        `vscode websocket upgrade failed: ${(err as Error).message}`,
      );
      duplex.destroy();
    }
  });
}
