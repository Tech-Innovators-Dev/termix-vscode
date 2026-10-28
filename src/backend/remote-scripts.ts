const SESSION_ID_PATTERN = /^[0-9a-f]{16}$/;

export function isSessionId(value: unknown): value is string {
  return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) throw new Error("Invalid session id");
}

/** Quotes a value as one POSIX shell word. Every script here is fed to `sh -s`. */
export function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export const RemoteScripts = {
  probeEnvironment: (customPath?: string) => `
    CUSTOM=${shQuote(customPath ?? "")}
    BIN=""
    if [ -n "$CUSTOM" ] && [ -x "$CUSTOM" ]; then
      BIN="$CUSTOM"
    elif command -v code-server >/dev/null 2>&1; then
      BIN="$(command -v code-server)"
    fi

    echo "OS:$(uname -s)"
    echo "ARCH:$(uname -m)"
    if [ -n "$BIN" ]; then
      echo "FOUND:$BIN"
    else
      echo "NOT_FOUND"
    fi
  `,

  launchCodeServer: (options: {
    binaryPath: string;
    sessionId: string;
    workspacePath: string;
    /** How often the remote watchdog looks at the heartbeat file. */
    watchdogIntervalSec?: number;
    /** Whole minutes without a heartbeat before the watchdog stops the server. */
    heartbeatTimeoutMin?: number;
  }) => {
    assertSessionId(options.sessionId);
    const interval = Math.max(1, Math.trunc(options.watchdogIntervalSec ?? 30));
    const timeoutMin = Math.max(
      1,
      Math.trunc(options.heartbeatTimeoutMin ?? 3),
    );
    return `
    BIN=${shQuote(options.binaryPath)}
    WORKSPACE=${shQuote(options.workspacePath)}
    case "$WORKSPACE" in
      "~") WORKSPACE="$HOME" ;;
      "~/"*) WORKSPACE="$HOME/$(printf '%s' "$WORKSPACE" | cut -c3-)" ;;
    esac

    if [ ! -e "$WORKSPACE" ]; then
      echo "NO_WORKSPACE"
      exit 3
    fi
    # code-server opens folders and .code-workspace files; given any other file
    # it starts an empty window, so say so instead.
    if [ -f "$WORKSPACE" ]; then
      case "$WORKSPACE" in
        *.code-workspace) ;;
        *) echo "UNSUPPORTED_FILE"; exit 4 ;;
      esac
    fi

    SESSION_DIR="$HOME/.termix/vscode/${options.sessionId}"
    mkdir -p "$SESSION_DIR" || exit 1
    PID_FILE="$SESSION_DIR/server.pid"
    LOG_FILE="$SESSION_DIR/server.log"

    # code-server hands a second launch to a running instance that shares its
    # data directory, and the second server then never starts. A data directory
    # of its own per session avoids that; settings and extensions stay shared
    # with the user's regular code-server by linking to them.
    DATA_HOME="\${XDG_DATA_HOME:-$HOME/.local/share}/code-server"
    mkdir -p "$DATA_HOME/User" "$DATA_HOME/Machine" "$DATA_HOME/extensions" "$SESSION_DIR/data" || exit 1
    ln -s "$DATA_HOME/User" "$SESSION_DIR/data/User"
    ln -s "$DATA_HOME/Machine" "$SESSION_DIR/data/Machine"

    get_free_port() {
      if command -v python3 >/dev/null 2>&1; then
        python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
      elif command -v python >/dev/null 2>&1; then
        python -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1", 0)); print(s.getsockname()[1]); s.close()'
      else
        awk 'BEGIN { srand(); print int(rand() * 25000) + 35000 }'
      fi
    }

    PORT="$(get_free_port)"

    # A session of its own, so stopping it takes the node children with it.
    RUNNER=""
    if command -v setsid >/dev/null 2>&1; then RUNNER="setsid"; fi

    $RUNNER nohup "$BIN" \\
      --bind-addr "127.0.0.1:$PORT" \\
      --auth none \\
      --disable-telemetry \\
      --disable-update-check \\
      --disable-workspace-trust \\
      --ignore-last-opened \\
      --user-data-dir "$SESSION_DIR/data" \\
      --extensions-dir "$DATA_HOME/extensions" \\
      "$WORKSPACE" </dev/null > "$LOG_FILE" 2>&1 &

    SERVER_PID=$!
    echo "$SERVER_PID" > "$PID_FILE"

    # Termix touches the heartbeat while it is connected. If it dies without
    # stopping the session, this takes the server down instead of leaving it.
    : > "$SESSION_DIR/heartbeat"
    WATCHDOG='
    PID="$1"; DIR="$2"; INTERVAL="$3"; TIMEOUT="$4"
    while kill -0 "$PID" 2>/dev/null; do
      sleep "$INTERVAL"
      if [ -n "$(find "$DIR/heartbeat" -mmin "+$TIMEOUT" 2>/dev/null)" ]; then
        kill -s TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null
        sleep 2
        kill -s KILL -- "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null
        rm -rf "$DIR"
        exit 0
      fi
    done
    '
    $RUNNER nohup sh -c "$WATCHDOG" sh "$SERVER_PID" "$SESSION_DIR" ${interval} ${timeoutMin} </dev/null >/dev/null 2>&1 &
    echo "$!" > "$SESSION_DIR/watchdog.pid"

    echo "SPAWNED:$PORT:$SERVER_PID"
  `;
  },

  checkReadiness: (sessionId: string, port: number, maxRetries = 25) => {
    assertSessionId(sessionId);
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error("Invalid port");
    return `
    SESSION_DIR="$HOME/.termix/vscode/${sessionId}"
    PID="$(cat "$SESSION_DIR/server.pid" 2>/dev/null)"
    PORT=${port}
    COUNT=0

    while [ $COUNT -lt ${Math.trunc(maxRetries)} ]; do
      if ! kill -0 "$PID" 2>/dev/null; then
        echo "DIED"
        tail -n 20 "$SESSION_DIR/server.log" 2>/dev/null
        exit 1
      fi
      if command -v curl >/dev/null 2>&1; then
        STATUS="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT" || true)"
        if [ "$STATUS" = "200" ] || [ "$STATUS" = "302" ]; then
          echo "READY"
          exit 0
        fi
      elif command -v nc >/dev/null 2>&1; then
        if nc -z 127.0.0.1 "$PORT" >/dev/null 2>&1; then
          echo "READY"
          exit 0
        fi
      else
        # Nothing to probe with: give it a moment and let the tunnel find out.
        sleep 2
        echo "READY"
        exit 0
      fi
      sleep 0.4
      COUNT=$((COUNT + 1))
    done

    echo "TIMEOUT"
    tail -n 20 "$SESSION_DIR/server.log" 2>/dev/null
    exit 1
  `;
  },

  heartbeat: (sessionId: string) => {
    assertSessionId(sessionId);
    return `touch "$HOME/.termix/vscode/${sessionId}/heartbeat" 2>/dev/null && echo "BEAT"`;
  },

  terminateSession: (sessionId: string) => {
    assertSessionId(sessionId);
    return `
    SESSION_DIR="$HOME/.termix/vscode/${sessionId}"
    PID_FILE="$SESSION_DIR/server.pid"

    if [ -f "$SESSION_DIR/watchdog.pid" ]; then
      WATCHER="$(cat "$SESSION_DIR/watchdog.pid")"
      case "$WATCHER" in
        ''|*[!0-9]*) ;;
        *) kill -s TERM "$WATCHER" 2>/dev/null || true ;;
      esac
    fi

    if [ -f "$PID_FILE" ]; then
      PID="$(cat "$PID_FILE")"
      case "$PID" in
        ''|*[!0-9]*) ;;
        *)
          kill -s TERM -- "-$PID" 2>/dev/null || kill -TERM "$PID" 2>/dev/null || true
          sleep 0.5
          kill -s KILL -- "-$PID" 2>/dev/null || kill -KILL "$PID" 2>/dev/null || true
          ;;
      esac
    fi
    rm -rf "$SESSION_DIR"
    echo "TERMINATED"
  `;
  },
};
