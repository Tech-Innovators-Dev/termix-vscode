import { randomBytes } from "node:crypto";
import type { Client, ClientChannel } from "ssh2";
import { RemoteScripts } from "./remote-scripts.js";

export interface HostProbeResult {
  os: string;
  arch: string;
  binaryPath: string | null;
  isSupported: boolean;
}

export interface RemoteLaunchResult {
  sessionId: string;
  port: number;
  pid: number;
}

interface ExecResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

const DEFAULT_EXEC_TIMEOUT_MS = 30_000;
const READINESS_TIMEOUT_MS = 45_000;

export class RemoteVSCodeAgent {
  constructor(private readonly client: Client) {}

  /** Feeds the script to `sh -s` so the remote login shell never parses it. */
  private runScript(
    script: string,
    timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  ): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      this.client.exec(
        "sh -s",
        (err: Error | undefined, channel: ClientChannel) => {
          if (err) return reject(err);

          let stdout = "";
          let stderr = "";
          const timer = setTimeout(() => {
            channel.close();
            reject(new Error(`Remote command timed out after ${timeoutMs}ms`));
          }, timeoutMs);

          channel.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
          });
          channel.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
          });
          channel.on("close", (code: number | null) => {
            clearTimeout(timer);
            resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
          });

          channel.end(script);
        },
      );
    });
  }

  async probeHost(customPath?: string): Promise<HostProbeResult> {
    const { stdout, code } = await this.runScript(
      RemoteScripts.probeEnvironment(customPath),
    );

    if (code !== 0 && !stdout) {
      throw new Error(`Probe failed with exit code ${code}`);
    }

    let os = "";
    let arch = "";
    let binaryPath: string | null = null;

    for (const line of stdout.split("\n")) {
      if (line.startsWith("OS:")) os = line.slice("OS:".length).trim();
      if (line.startsWith("ARCH:")) arch = line.slice("ARCH:".length).trim();
      if (line.startsWith("FOUND:"))
        binaryPath = line.slice("FOUND:".length).trim();
    }

    return { os, arch, binaryPath, isSupported: binaryPath !== null };
  }

  async launchSession(options: {
    workspacePath: string;
    customBinaryPath?: string;
  }): Promise<RemoteLaunchResult> {
    const probe = await this.probeHost(options.customBinaryPath);
    if (!probe.isSupported || !probe.binaryPath) {
      throw new Error("ERR_CODE_SERVER_NOT_INSTALLED");
    }

    const sessionId = randomBytes(8).toString("hex");
    const { stdout, code, stderr } = await this.runScript(
      RemoteScripts.launchCodeServer({
        binaryPath: probe.binaryPath,
        sessionId,
        workspacePath: options.workspacePath,
      }),
    );
    if (stdout.includes("UNSUPPORTED_FILE")) {
      throw new Error("ERR_WORKSPACE_UNSUPPORTED");
    }
    if (stdout.includes("NO_WORKSPACE")) {
      throw new Error("ERR_WORKSPACE_NOT_FOUND");
    }
    if (code !== 0) {
      throw new Error(`Launch script failed: ${stderr || stdout}`);
    }

    const match = stdout.match(/SPAWNED:(\d+):(\d+)/);
    if (!match) {
      throw new Error(`Malformed spawn output: ${stdout}`);
    }

    const port = Number.parseInt(match[1], 10);
    const pid = Number.parseInt(match[2], 10);

    try {
      const readiness = await this.runScript(
        RemoteScripts.checkReadiness(sessionId, port),
        READINESS_TIMEOUT_MS,
      );
      if (!readiness.stdout.startsWith("READY")) {
        const detail = readiness.stdout.split("\n").slice(1).join("\n");
        throw new Error(
          `VS Code server failed to start on 127.0.0.1:${port}${detail ? `:\n${detail}` : ""}`,
        );
      }
    } catch (err) {
      await this.killSession(sessionId).catch(() => undefined);
      throw err;
    }

    return { sessionId, port, pid };
  }

  /** True while the session directory still exists on the host. */
  async heartbeat(sessionId: string): Promise<boolean> {
    const { stdout } = await this.runScript(
      RemoteScripts.heartbeat(sessionId),
      10_000,
    );
    return stdout.includes("BEAT");
  }

  async killSession(sessionId: string): Promise<void> {
    await this.runScript(RemoteScripts.terminateSession(sessionId));
  }
}
