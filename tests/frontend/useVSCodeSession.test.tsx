import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const api = { post: vi.fn() };
vi.mock("@termix-ssh/plugin-sdk/frontend", () => ({ usePluginApi: () => api }));

import { useVSCodeSession } from "../../src/frontend/hooks/useVSCodeSession.js";

// Rendering the real plugin host is slow on a busy machine.
vi.setConfig({ testTimeout: 30_000 });

let counter = 0;
const started = () =>
  api.post.mock.calls.filter(([url]) => url === "/session/start");
const stopped = () =>
  api.post.mock.calls
    .filter(([url]) => /\/stop$/.test(url as string))
    .map(([url]) => (url as string).split("/")[2]);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>(
    (res, rej) => ((resolve = res), (reject = rej)),
  );
  return { promise, resolve, reject };
}

const ok = (id: string) => ({
  data: {
    sessionId: id,
    iframeUrl: `/plugin-api/termix-vscode/session/${id}/`,
  },
});

beforeEach(() => {
  counter = 0;
  api.post.mockReset();
  api.post.mockImplementation(async (url: string) =>
    url === "/session/start"
      ? ok(`s${++counter}`)
      : { data: { success: true } },
  );
});
afterEach(cleanup);

describe("useVSCodeSession", () => {
  test("starts exactly one session per mount and does not relaunch once running", async () => {
    const { result } = renderHook(() => useVSCodeSession("7"));
    expect(result.current.status).toBe("launching");
    await waitFor(() => expect(result.current.status).toBe("running"));
    await new Promise((r) => setTimeout(r, 30));

    expect(started()).toHaveLength(1);
    expect(started()[0][1]).toEqual({ hostId: 7 });
    expect(stopped()).toEqual([]);
    expect(result.current.iframeUrl).toBe(
      "/plugin-api/termix-vscode/session/s1/",
    );
  });

  test("without a host it stays idle and calls nothing", async () => {
    const { result } = renderHook(() => useVSCodeSession(undefined));
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.status).toBe("idle");
    expect(api.post).not.toHaveBeenCalled();
  });

  test("nothing starts until a workspace is decided (null), then it opens that path", async () => {
    const { result, rerender } = renderHook(
      ({ path }) => useVSCodeSession("7", path),
      {
        initialProps: { path: null as string | null },
      },
    );
    await new Promise((r) => setTimeout(r, 30));
    expect(result.current.status).toBe("idle");
    expect(api.post).not.toHaveBeenCalled();

    rerender({ path: "~/work/api" });
    await waitFor(() => expect(result.current.status).toBe("running"));
    expect(started()[0][1]).toEqual({ hostId: 7, workspacePath: "~/work/api" });

    rerender({ path: "~/other" });
    await waitFor(() => expect(result.current.sessionId).toBe("s2"));
    expect(stopped()).toEqual(["s1"]);
  });

  test("maps the server's codes to statuses", async () => {
    for (const [code, status] of [
      ["WORKSPACE_NOT_FOUND", "workspace_missing"],
      ["WORKSPACE_UNSUPPORTED", "workspace_unsupported"],
      ["TOO_MANY_SESSIONS", "too_many"],
      ["NOT_INSTALLED", "not_installed"],
      ["SOMETHING_ELSE", "error"],
    ]) {
      api.post.mockRejectedValueOnce({ response: { data: { code } } });
      const { result, unmount } = renderHook(() => useVSCodeSession("7"));
      await waitFor(() => expect(result.current.status).toBe(status));
      unmount();
    }
  });

  test("stops the session on unmount", async () => {
    const { result, unmount } = renderHook(() => useVSCodeSession("7"));
    await waitFor(() => expect(result.current.status).toBe("running"));
    unmount();
    expect(stopped()).toEqual(["s1"]);
  });

  test("a session that finishes starting after unmount is stopped, not leaked", async () => {
    const gate = deferred<ReturnType<typeof ok>>();
    api.post.mockImplementationOnce(() => gate.promise);
    const { unmount } = renderHook(() => useVSCodeSession("7"));
    unmount();
    expect(stopped()).toEqual([]);
    await act(async () => gate.resolve(ok("late")));
    expect(stopped()).toEqual(["late"]);
  });

  test("under StrictMode every extra session is stopped and one stays", async () => {
    const { result } = renderHook(() => useVSCodeSession("7"), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.status).toBe("running"));
    await new Promise((r) => setTimeout(r, 30));

    const live = result.current.sessionId;
    const all = started().length;
    expect(stopped().sort()).toEqual(
      Array.from({ length: all }, (_, i) => `s${i + 1}`)
        .filter((id) => id !== live)
        .sort(),
    );
    expect(stopped()).not.toContain(live);
  });

  test("changing the host stops the old session and starts one for the new host", async () => {
    const { result, rerender } = renderHook(({ id }) => useVSCodeSession(id), {
      initialProps: { id: "7" },
    });
    await waitFor(() => expect(result.current.sessionId).toBe("s1"));
    rerender({ id: "8" });
    await waitFor(() => expect(result.current.sessionId).toBe("s2"));
    expect(stopped()).toEqual(["s1"]);
    expect(started().map(([, body]) => body)).toEqual([
      { hostId: 7 },
      { hostId: 8 },
    ]);
  });

  test("a missing code-server is reported as not_installed, anything else as an error", async () => {
    api.post.mockRejectedValueOnce({
      response: { data: { code: "NOT_INSTALLED", error: "x" } },
    });
    const { result } = renderHook(() => useVSCodeSession("7"));
    await waitFor(() => expect(result.current.status).toBe("not_installed"));

    api.post.mockRejectedValueOnce({ response: { data: { error: "boom" } } });
    await act(async () => result.current.retry());
    expect(result.current.status).toBe("error");
    expect(result.current.errorMessage).toBe("boom");

    api.post.mockRejectedValueOnce(new Error("Network Error"));
    await act(async () => result.current.retry());
    expect(result.current.errorMessage).toBe("Network Error");
  });

  test("retry replaces a running session; only the newest survives", async () => {
    const { result } = renderHook(() => useVSCodeSession("7"));
    await waitFor(() => expect(result.current.sessionId).toBe("s1"));
    await act(async () => result.current.retry());
    expect(result.current.sessionId).toBe("s2");
    expect(stopped()).toEqual(["s1"]);
  });

  test("a stale response from an earlier attempt cannot overwrite a newer one", async () => {
    const slow = deferred<ReturnType<typeof ok>>();
    api.post.mockImplementationOnce(() => slow.promise);
    const { result } = renderHook(() => useVSCodeSession("7"));
    await act(async () => void result.current.retry()); // second attempt, answers at once
    await waitFor(() => expect(result.current.sessionId).toBe("s1"));
    await act(async () => slow.resolve(ok("stale")));
    expect(result.current.sessionId).toBe("s1");
    expect(stopped()).toEqual(["stale"]);
  });

  test("terminate stops the session and returns to idle; a failing stop is swallowed", async () => {
    const { result } = renderHook(() => useVSCodeSession("7"));
    await waitFor(() => expect(result.current.status).toBe("running"));
    api.post.mockRejectedValueOnce(new Error("offline"));
    act(() => result.current.terminate());
    expect(result.current.status).toBe("idle");
    expect(result.current.iframeUrl).toBeNull();
    expect(stopped()).toEqual(["s1"]);
  });
});
