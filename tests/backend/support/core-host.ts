/**
 * A stand-in for the parts of Termix core a plugin's HTTP and socket routes
 * pass through. The logic mirrors core 26.10.5 (src/backend/plugins/http.ts,
 * plugins/ws.ts, utils/ws-auth.ts, database/routes/plugin-api-routes.ts):
 *
 *   - /plugin-api/<id>/… is dispatched through `app.use("/plugin-api")` and
 *     `router.use("/:pluginId")`, behind a cookie/Bearer login check that sets
 *     the acting user;
 *   - /plugin-ws/<id>/<path> matches a registered path EXACTLY (no params, no
 *     wildcards), authenticates, and hands the raw upgrade plus the user id.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import express from "express";
import type { Request, Response, NextFunction, Router } from "express";
import { createMockCtx } from "@termix-ssh/plugin-sdk/testing";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import manifest from "../../../manifest.json" with { type: "json" };
import type { FakeSshServer } from "./fake-ssh.js";

type RawUpgrade = (
  req: http.IncomingMessage,
  socket: Duplex,
  head: Buffer,
  userId: string,
) => void;

export interface CoreHostOptions {
  ssh: FakeSshServer;
  /** token -> user id. A cookie `jwt=<token>` authenticates as that user. */
  users: Record<string, string>;
  /** user id -> short permission names held. Missing = everything. */
  permissions?: Record<string, string[]>;
  /** host-scope plugin settings, keyed "<hostId>:<key>". */
  hostSettings?: Record<string, string>;
  /** Host ids the actor may connect to. Defaults to every id. */
  knownHosts?: number[];
  /** Called with the ctx, once, to run the plugin's own activate. */
  activate: (ctx: PluginContext) => Promise<void> | void;
}

export interface CoreHost {
  baseUrl: string;
  host: string;
  ctx: PluginContext;
  server: http.Server;
  wsPaths: () => string[];
  runScheduled: () => Promise<void>;
  scheduledCount: () => number;
  /** Runs what the plugin registered with ctx.settings.onValidate("host"). */
  validateHostSettings: (
    values: Record<string, unknown>,
  ) => Promise<Record<string, string>>;
  disposeAll: () => Promise<void>;
  close: () => Promise<void>;
}

function cookieOriginAllowed(req: http.IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  if (req.headers["sec-fetch-site"] === "same-origin") return true;
  try {
    return (
      new URL(origin).host.toLowerCase() ===
      String(req.headers.host ?? "").toLowerCase()
    );
  } catch {
    return false;
  }
}

function tokenFromUpgrade(req: http.IncomingMessage): string | undefined {
  const cookie = req.headers.cookie;
  if (cookie && cookieOriginAllowed(req)) {
    const match = cookie.match(/(?:^|;\s*)jwt=([^;]+)/);
    if (match) return decodeURIComponent(match[1]);
  }
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const protocol = String(req.headers["sec-websocket-protocol"] ?? "")
    .split(",")
    .map((value) => value.trim())
    .find((value) => value.startsWith("termix.jwt."));
  return protocol?.slice("termix.jwt.".length);
}

export async function startCoreHost(
  options: CoreHostOptions,
): Promise<CoreHost> {
  const actor = new AsyncLocalStorage<string>();
  let innerRouter: Router | null = null;

  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest: manifest as never,
    capabilities: manifest.capabilities as never,
    router: () => (innerRouter = express.Router()),
    baseUrl: "http://placeholder",
  } as never);

  const heldBy = (userId: string, permission: string) => {
    const held = options.permissions?.[userId];
    return held === undefined || held.includes(permission);
  };

  // The real ctx would run these against core; here they read the harness.
  const ctx = Object.assign(Object.create(mock.ctx), {
    currentActor: () => actor.getStore(),
    http: {
      ...mock.ctx.http,
      router: mock.ctx.http.router,
      baseUrl: (req: Request) => `${req.protocol}://${req.headers.host}`,
    },
    rbac: {
      ...mock.ctx.rbac,
      hasFor: async (userId: string, permission: string) =>
        heldBy(userId, permission),
      require:
        (permission: string) =>
        (req: Request, res: Response, next: NextFunction) => {
          const userId = actor.getStore();
          if (userId && heldBy(userId, permission)) return next();
          res.status(403).json({ error: "Forbidden" });
        },
    },
    settings: {
      ...mock.ctx.settings,
      getHost: async (hostId: number | string, key: string) =>
        options.hostSettings?.[`${hostId}:${key}`],
    },
    ssh: {
      ...mock.ctx.ssh,
      connect: async () => options.ssh.connect(),
      resolveHost: async (hostId: number) =>
        !options.knownHosts || options.knownHosts.includes(hostId)
          ? { id: hostId }
          : null,
    },
  }) as PluginContext;

  await options.activate(ctx);
  if (!innerRouter) throw new Error("plugin did not call ctx.http.router()");

  const pluginRouter = express.Router();
  pluginRouter.use((req, res, next) => {
    const token = req.headers.cookie?.match(/(?:^|;\s*)jwt=([^;]+)/)?.[1];
    const userId = token ? options.users[decodeURIComponent(token)] : undefined;
    if (!userId)
      return void res
        .status(401)
        .json({ error: "Missing authentication token" });
    actor.run(userId, next);
  });
  pluginRouter.use(innerRouter);

  const dispatcher = express.Router();
  dispatcher.use("/:pluginId", (req, res, next) => {
    if (req.params.pluginId !== manifest.id) return void res.status(404).end();
    pluginRouter(req, res, next);
  });
  const app = express();
  app.use("/plugin-api", dispatcher);

  const server = http.createServer(app);
  server.on("upgrade", (req, socket, head) => {
    const reject = (status: number) => {
      socket.write(`HTTP/1.1 ${status} X\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    const pathname = (req.url ?? "").split("?")[0];
    const match = /^\/plugin-ws\/([^/]+)(\/.+)$/.exec(pathname);
    const route =
      match && match[1] === manifest.id
        ? mock.wsRoutes.find((candidate) => candidate.path === match[2])
        : undefined;
    if (!route?.upgrade) return reject(404);

    const token = tokenFromUpgrade(req);
    const userId = token ? options.users[token] : undefined;
    if (!userId) return reject(401);
    if (req.headers.cookie && !cookieOriginAllowed(req))
      delete req.headers.cookie;

    const upgrade = route.upgrade as unknown as RawUpgrade;
    actor.run(userId, () => upgrade(req, socket, head, userId));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    host: `127.0.0.1:${port}`,
    ctx,
    server,
    wsPaths: () => mock.wsRoutes.map((route) => route.path),
    validateHostSettings: (values) =>
      mock.validateSettings("host", values, { hostId: 1 }),
    runScheduled: () => mock.runScheduled(),
    scheduledCount: () => mock.scheduled.length,
    disposeAll: async () => {
      for (const dispose of mock.disposals) await dispose();
    },
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
