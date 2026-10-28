import type http from "node:http";
import type { Duplex } from "node:stream";
import type { Client } from "ssh2";
import { RemoteVSCodeAgent } from "./remote-agent.js";
import { createTunnelAgent } from "./tunnel-bridge.js";

export const ERR_TOO_MANY_SESSIONS = "ERR_TOO_MANY_SESSIONS";

export interface ActiveSession {
  sessionId: string;
  hostId: number;
  ownerId: string;
  remotePort: number;
  /** Opens one SSH channel per connection, straight to the remote daemon. */
  tunnelAgent: http.Agent;
  agent: RemoteVSCodeAgent;
  /** Ends the SSH connection the session runs over. */
  disconnect: () => void;
  /** Browser-side sockets (WebSockets) proxied for this session. */
  sockets: Set<Duplex>;
  lastActivity: number;
}

export interface SessionManagerOptions {
  maxSessionsPerUser?: number;
  now?: () => number;
}

export class VSCodeSessionManager {
  private sessions = new Map<string, ActiveSession>();
  private pendingByOwner = new Map<string, number>();
  private readonly maxSessionsPerUser: number;
  private readonly now: () => number;

  constructor(options: SessionManagerOptions = {}) {
    this.maxSessionsPerUser = options.maxSessionsPerUser ?? 5;
    this.now = options.now ?? Date.now;
  }

  private countFor(ownerId: string): number {
    let count = this.pendingByOwner.get(ownerId) ?? 0;
    for (const session of this.sessions.values())
      if (session.ownerId === ownerId) count++;
    return count;
  }

  /** The caller keeps `disconnect` ownership only until this resolves or throws. */
  async startSession(options: {
    client: Client;
    disconnect: () => void;
    hostId: number;
    ownerId: string;
    workspacePath?: string;
    customBinaryPath?: string;
  }): Promise<ActiveSession> {
    if (this.countFor(options.ownerId) >= this.maxSessionsPerUser) {
      options.disconnect();
      throw new Error(ERR_TOO_MANY_SESSIONS);
    }
    this.pendingByOwner.set(
      options.ownerId,
      (this.pendingByOwner.get(options.ownerId) ?? 0) + 1,
    );

    const agent = new RemoteVSCodeAgent(options.client);
    try {
      let launchResult;
      try {
        launchResult = await agent.launchSession({
          workspacePath: options.workspacePath ?? "~",
          customBinaryPath: options.customBinaryPath,
        });
      } catch (err) {
        options.disconnect();
        throw err;
      }

      const session: ActiveSession = {
        sessionId: launchResult.sessionId,
        hostId: options.hostId,
        ownerId: options.ownerId,
        remotePort: launchResult.port,
        tunnelAgent: createTunnelAgent(options.client, launchResult.port),
        agent,
        disconnect: options.disconnect,
        sockets: new Set(),
        lastActivity: this.now(),
      };
      this.sessions.set(session.sessionId, session);

      // A dropped connection ends the session; the host's watchdog stops the
      // remote server once the heartbeat goes quiet.
      options.client.once("close", () => {
        if (!this.release(session)) return;
        try {
          session.disconnect();
        } catch {
          // Already closed.
        }
      });
      return session;
    } finally {
      const left = (this.pendingByOwner.get(options.ownerId) ?? 1) - 1;
      if (left > 0) this.pendingByOwner.set(options.ownerId, left);
      else this.pendingByOwner.delete(options.ownerId);
    }
  }

  /** Forgets a session and drops everything local to it. Idempotent. */
  private release(session: ActiveSession): boolean {
    if (this.sessions.get(session.sessionId) !== session) return false;
    this.sessions.delete(session.sessionId);
    session.tunnelAgent.destroy();
    for (const socket of session.sockets) socket.destroy();
    session.sockets.clear();
    return true;
  }

  /** Stops a session, or does nothing for an unknown id. */
  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || !this.release(session)) return;

    try {
      await session.agent.killSession(sessionId);
    } catch {
      // The remote host or SSH connection may already be gone.
    } finally {
      session.disconnect();
    }
  }

  /** The session, only when `ownerId` started it. */
  getSessionFor(
    sessionId: string,
    ownerId: string | undefined,
  ): ActiveSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session || !ownerId || session.ownerId !== ownerId) return undefined;
    return session;
  }

  touch(session: ActiveSession): void {
    session.lastActivity = this.now();
  }

  /** Tracks a proxied browser socket so stop can close it and idleness can see it. */
  trackSocket(session: ActiveSession, socket: Duplex): void {
    session.sockets.add(socket);
    this.touch(session);
    socket.once("close", () => {
      session.sockets.delete(socket);
      this.touch(session);
    });
  }

  /** Stops sessions with no open socket and no request for `idleMs`. */
  async reapIdle(idleMs: number): Promise<string[]> {
    const cutoff = this.now() - idleMs;
    const idle = [...this.sessions.values()].filter(
      (session) => session.sockets.size === 0 && session.lastActivity <= cutoff,
    );
    await Promise.all(
      idle.map((session) => this.stopSession(session.sessionId)),
    );
    return idle.map((session) => session.sessionId);
  }

  /** Tells each host its session is still wanted. A host that lost it ends the session. */
  async heartbeatAll(): Promise<void> {
    await Promise.all(
      [...this.sessions.values()].map(async (session) => {
        try {
          if (!(await session.agent.heartbeat(session.sessionId))) {
            await this.stopSession(session.sessionId);
          }
        } catch {
          // A dead SSH connection closes the session through its close event.
        }
      }),
    );
  }

  get size(): number {
    return this.sessions.size;
  }

  async disposeAll(): Promise<void> {
    await Promise.all(
      Array.from(this.sessions.keys()).map((id) => this.stopSession(id)),
    );
  }
}
