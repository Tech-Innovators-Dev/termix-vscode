import { spawn } from "node:child_process";
import net from "node:net";
import type { AddressInfo } from "node:net";
import ssh2 from "ssh2";

const { Client, Server, utils } = ssh2;
export type SshClient = InstanceType<typeof Client>;

/**
 * An SSH server that runs `sh -s` for real (as the plugin does against a host)
 * and forwards direct-tcpip channels to loopback.
 */
export class FakeSshServer {
  private server: InstanceType<typeof Server>;
  private connections = new Set<{ end: () => void }>();
  readonly clients = new Set<SshClient>();
  port = 0;
  /** PATH the host's commands run with. Tests narrow it to hide a real code-server. */
  path = process.env.PATH;
  execCount = 0;
  channelsOpened = 0;

  constructor(private readonly home: string) {
    const { private: hostKey } = utils.generateKeyPairSync("ed25519");
    this.server = new Server({ hostKeys: [hostKey] }, (client) => {
      this.connections.add(client);
      client.on("close", () => this.connections.delete(client));
      client.on("error", () => undefined);
      client.on("authentication", (ctx) => ctx.accept());
      client.on("ready", () => {
        client.on("session", (accept) => {
          const session = accept();
          session.on("exec", (acceptExec, reject, info) => {
            if (info.command !== "sh -s") return reject();
            this.execCount++;
            const channel = acceptExec();
            const child = spawn("sh", ["-s"], {
              env: { PATH: this.path, HOME: this.home },
            });
            channel.pipe(child.stdin);
            child.stdin.on("error", () => undefined);
            child.stdout.pipe(channel, { end: false });
            child.stderr.pipe(channel.stderr, { end: false });
            child.on("close", (code) => {
              channel.exit(code ?? 1);
              channel.end();
            });
          });
        });
        client.on("tcpip", (acceptTcp, reject, info) => {
          const upstream = net.connect(info.destPort, "127.0.0.1");
          upstream.once("connect", () => {
            this.channelsOpened++;
            const channel = acceptTcp();
            channel.pipe(upstream).pipe(channel);
            channel.on("error", () => upstream.destroy());
            channel.on("close", () => upstream.destroy());
            upstream.on("close", () => channel.destroy());
          });
          upstream.once("error", () => reject());
        });
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.listen(0, "127.0.0.1", resolve),
    );
    this.port = (this.server.address() as AddressInfo).port;
  }

  /** What ctx.ssh.connect would return: a ready client of its own. */
  async connect(): Promise<{ client: SshClient; dispose: () => void }> {
    const client = new Client();
    this.clients.add(client);
    client.on("close", () => this.clients.delete(client));
    await new Promise<void>((resolve, reject) => {
      client.once("ready", resolve).once("error", reject);
      client.connect({
        host: "127.0.0.1",
        port: this.port,
        username: "u",
        password: "p",
      });
    });
    return { client, dispose: () => client.end() };
  }

  /** Severs every connection from the server side, as a network drop would. */
  dropAll(): void {
    for (const connection of this.connections) connection.end();
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.end();
    this.dropAll();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
