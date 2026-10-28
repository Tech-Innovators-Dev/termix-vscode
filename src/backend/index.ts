import type { Router } from "express";
import type { PluginContext } from "@termix-ssh/plugin-sdk/backend";
import { parseWorkspaces } from "../shared/workspaces.js";
import { VSCodeSessionManager } from "./session-manager.js";
import { createProxyRouter } from "./proxy-router.js";

const HEARTBEAT_INTERVAL_MS = 60_000;
const REAP_INTERVAL_MS = 60_000;
/** A session with no open socket and no request for this long is stopped. */
const IDLE_TIMEOUT_MS = 15 * 60_000;

export async function activate(ctx: PluginContext) {
  const sessionManager = new VSCodeSessionManager();

  // rawBody: proxied requests (uploads into the workspace) must reach
  // code-server unparsed, so the start route reads its own small JSON body.
  const router = ctx.http.router<Router>({ rawBody: true });
  createProxyRouter(ctx, router, sessionManager);

  // Say what is wrong with the list before the host editor saves it.
  ctx.settings.onValidate("host", (values) => {
    const { errors } = parseWorkspaces(values.workspaces);
    return errors.length > 0 ? { workspaces: errors[0] } : undefined;
  });

  // Timers made through ctx.schedule stop on deactivate and never overlap.
  ctx.schedule.every(HEARTBEAT_INTERVAL_MS, () =>
    sessionManager.heartbeatAll(),
  );
  ctx.schedule.every(REAP_INTERVAL_MS, async () => {
    const reaped = await sessionManager.reapIdle(IDLE_TIMEOUT_MS);
    if (reaped.length > 0)
      ctx.log.info(`stopped ${reaped.length} idle VS Code session(s)`);
  });

  ctx.disposables.add(() => sessionManager.disposeAll());
}

export async function deactivate() {
  // Everything registered through ctx is disposed by core.
}
