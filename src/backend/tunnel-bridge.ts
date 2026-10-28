import http from "node:http";
import type { Duplex } from "node:stream";
import type { Client } from "ssh2";

// http and http-proxy call these on the socket they are handed. An ssh2 channel
// is a plain Duplex without them.
const SOCKET_METHODS = [
  "setTimeout",
  "setNoDelay",
  "setKeepAlive",
  "ref",
  "unref",
] as const;

function asSocket(stream: Duplex): Duplex {
  const target = stream as unknown as Record<string, unknown>;
  for (const method of SOCKET_METHODS) {
    if (typeof target[method] !== "function") target[method] = () => stream;
  }
  return stream;
}

/**
 * An http.Agent whose connections are SSH direct-tcpip channels to the remote
 * loopback port. Nothing listens on the Termix server, so only requests that
 * pass through the plugin's own routes can reach the remote daemon.
 */
export function createTunnelAgent(
  client: Client,
  remotePort: number,
): http.Agent {
  const agent = new http.Agent({ keepAlive: false });

  (
    agent as unknown as {
      createConnection: (
        options: unknown,
        callback: (err: Error | null, stream?: Duplex) => void,
      ) => void;
    }
  ).createConnection = (_options, callback) => {
    client.forwardOut(
      "127.0.0.1",
      0,
      "127.0.0.1",
      remotePort,
      (err, stream) => {
        if (err) return callback(err);
        callback(null, asSocket(stream));
      },
    );
  };

  return agent;
}
