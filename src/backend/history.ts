import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { pathProblem } from "../shared/workspaces.js";

const KEY = "recentWorkspaces";
const MAX_PER_HOST = 8;
const MAX_HOSTS = 50;

type Recent = Record<string, string[]>;

/**
 * The workspaces each user opened on each host, newest first, kept in the
 * user's own plugin settings. Reads and writes for one user run in turn so two
 * sessions starting together do not lose an entry.
 */
export class WorkspaceHistory {
  private queues = new Map<string, Promise<unknown>>();

  constructor(private readonly ctx: Pick<PluginContext, "settings">) {}

  private async load(userId: string): Promise<Recent> {
    const stored = await this.ctx.settings.getUser<unknown>(userId, KEY);
    const value = typeof stored === "string" ? safeParse(stored) : stored;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const recent: Recent = {};
    for (const [host, paths] of Object.entries(value)) {
      if (Array.isArray(paths)) {
        recent[host] = paths.filter(
          (path): path is string =>
            typeof path === "string" && !pathProblem(path),
        );
      }
    }
    return recent;
  }

  private serialized<T>(userId: string, work: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(userId) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    this.queues.set(userId, tail);
    void tail.then(() => {
      if (this.queues.get(userId) === tail) this.queues.delete(userId);
    });
    return run;
  }

  list(userId: string, hostId: number): Promise<string[]> {
    return this.serialized(
      userId,
      async () => (await this.load(userId))[String(hostId)] ?? [],
    );
  }

  record(userId: string, hostId: number, path: string): Promise<void> {
    const clean = path.trim();
    if (pathProblem(clean)) return Promise.resolve();
    return this.serialized(userId, async () => {
      const recent = await this.load(userId);
      const key = String(hostId);
      const paths = [
        clean,
        ...(recent[key] ?? []).filter((existing) => existing !== clean),
      ];
      // Re-adding moves the host to the end, so the oldest hosts are dropped first.
      delete recent[key];
      recent[key] = paths.slice(0, MAX_PER_HOST);
      const keys = Object.keys(recent);
      for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_HOSTS)))
        delete recent[stale];
      await this.ctx.settings.setUser(userId, KEY, recent);
    });
  }

  /** Drops a path that no longer exists on the host. */
  forget(userId: string, hostId: number, path: string): Promise<void> {
    return this.serialized(userId, async () => {
      const recent = await this.load(userId);
      const key = String(hostId);
      if (!recent[key]?.includes(path.trim())) return;
      recent[key] = recent[key].filter((existing) => existing !== path.trim());
      if (recent[key].length === 0) delete recent[key];
      await this.ctx.settings.setUser(userId, KEY, recent);
    });
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
