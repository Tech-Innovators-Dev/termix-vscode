import { useCallback, useEffect, useRef, useState } from "react";
import { usePluginApi } from "@termix-ssh/plugin-sdk/frontend";

export interface SessionState {
  status:
    | "idle"
    | "launching"
    | "running"
    | "error"
    | "not_installed"
    | "workspace_missing"
    | "workspace_unsupported"
    | "too_many";
  iframeUrl: string | null;
  sessionId: string | null;
  errorMessage: string | null;
}

interface StartResponse {
  sessionId: string;
  iframeUrl: string;
}

const IDLE: SessionState = {
  status: "idle",
  iframeUrl: null,
  sessionId: null,
  errorMessage: null,
};

const STATUS_BY_CODE: Record<string, SessionState["status"]> = {
  NOT_INSTALLED: "not_installed",
  WORKSPACE_NOT_FOUND: "workspace_missing",
  WORKSPACE_UNSUPPORTED: "workspace_unsupported",
  TOO_MANY_SESSIONS: "too_many",
};

function errorDetails(err: unknown): { code?: string; message: string } {
  const data = (
    err as { response?: { data?: { code?: string; error?: string } } }
  )?.response?.data;
  return {
    code: data?.code,
    message: data?.error || (err instanceof Error ? err.message : ""),
  };
}

/**
 * Runs one VS Code session for a host. `workspacePath` is what to open:
 * a string opens it, undefined opens the host's default, and null means the
 * caller has not decided yet, so nothing starts.
 */
export function useVSCodeSession(
  hostId: string | undefined,
  workspacePath?: string | null,
) {
  // The client's identity is not part of the session's lifecycle.
  const api = usePluginApi();
  const apiRef = useRef(api);
  apiRef.current = api;

  const [state, setState] = useState<SessionState>(IDLE);
  // The session this hook owns, and which launch attempt may still claim it.
  const sessionRef = useRef<string | null>(null);
  const attemptRef = useRef(0);

  const stop = useCallback(async (sessionId: string) => {
    try {
      await apiRef.current.post(`/session/${sessionId}/stop`);
    } catch {
      // Already gone, or the server is unreachable: nothing more to release.
    }
  }, []);

  const release = useCallback(() => {
    attemptRef.current++;
    const sessionId = sessionRef.current;
    sessionRef.current = null;
    if (sessionId) void stop(sessionId);
  }, [stop]);

  const launch = useCallback(async () => {
    release();
    const attempt = attemptRef.current;
    if (!hostId || workspacePath === null) {
      setState(IDLE);
      return;
    }
    setState({ ...IDLE, status: "launching" });

    try {
      const { data } = await apiRef.current.post<StartResponse>(
        "/session/start",
        {
          hostId: Number(hostId),
          ...(typeof workspacePath === "string" ? { workspacePath } : {}),
        },
      );
      if (attempt !== attemptRef.current) {
        // Unmounted or retried while the host was starting.
        void stop(data.sessionId);
        return;
      }
      sessionRef.current = data.sessionId;
      setState({
        status: "running",
        iframeUrl: data.iframeUrl,
        sessionId: data.sessionId,
        errorMessage: null,
      });
    } catch (err) {
      if (attempt !== attemptRef.current) return;
      const { code, message } = errorDetails(err);
      setState({
        ...IDLE,
        status: (code && STATUS_BY_CODE[code]) || "error",
        errorMessage: message || null,
      });
    }
  }, [hostId, workspacePath, release, stop]);

  const terminate = useCallback(() => {
    release();
    setState(IDLE);
  }, [release]);

  useEffect(() => {
    void launch();
    return release;
  }, [launch, release]);

  return { ...state, retry: launch, terminate };
}
