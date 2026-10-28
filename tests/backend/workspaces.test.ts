import { describe, expect, test } from "vitest";
import { WorkspaceHistory } from "../../src/backend/history.js";
import { parseWorkspaces, pathProblem } from "../../src/shared/workspaces.js";

describe("parseWorkspaces", () => {
  test("reads Name = path lines, bare paths, comments and blanks", () => {
    const { entries, errors } = parseWorkspaces(
      [
        "# my places",
        "",
        "API = ~/work/api",
        "  Infra=~/work/infra/infra.code-workspace  ",
        "/var/www",
        "~/notes/",
        "Odd = /srv/a=b",
        "/srv/c=d",
      ].join("\n"),
    );
    expect(errors).toEqual([]);
    expect(entries).toEqual([
      { name: "API", path: "~/work/api" },
      { name: "Infra", path: "~/work/infra/infra.code-workspace" },
      { name: "www", path: "/var/www" },
      { name: "notes", path: "~/notes/" },
      { name: "Odd", path: "/srv/a=b" },
      { name: "c=d", path: "/srv/c=d" },
    ]);
  });

  test("handles CRLF and non-string input", () => {
    expect(
      parseWorkspaces("A = /a\r\nB = /b\r\n").entries.map((e) => e.name),
    ).toEqual(["A", "B"]);
    for (const value of [undefined, null, 5, {}, []]) {
      expect(parseWorkspaces(value)).toEqual({ entries: [], errors: [] });
    }
  });

  test("skips bad lines, keeps the good ones and says what is wrong", () => {
    const { entries, errors } = parseWorkspaces(
      [
        "Good = /ok",
        "Empty =",
        "= /noname",
        `Long${"x".repeat(70)} = /p`,
        "good = /dup",
        `Nul = /a\0b`,
      ].join("\n"),
    );
    expect(entries).toEqual([{ name: "Good", path: "/ok" }]);
    expect(errors).toEqual([
      "Line 2: The path is empty",
      "Line 3: the name is empty",
      expect.stringContaining("Line 4: the name is longer"),
      'Line 5: "good" is listed twice',
      "Line 6: The path contains a NUL character",
    ]);
  });

  test("caps the list", () => {
    const text = Array.from({ length: 25 }, (_, i) => `W${i} = /p${i}`).join(
      "\n",
    );
    const { entries, errors } = parseWorkspaces(text);
    expect(entries).toHaveLength(20);
    expect(errors).toHaveLength(5);
  });

  test("pathProblem", () => {
    expect(pathProblem("~/a")).toBeNull();
    expect(pathProblem("")).not.toBeNull();
    expect(pathProblem("x".repeat(5000))).not.toBeNull();
  });
});

function fakeSettings(initial: Record<string, unknown> = {}) {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    store,
    settings: {
      getUser: async (user: string, key: string) => store.get(`${user}:${key}`),
      setUser: async (user: string, key: string, value: unknown) => {
        // Yield, so interleaved read-modify-writes would lose updates if unserialized.
        await new Promise((resolve) => setTimeout(resolve, 1));
        store.set(`${user}:${key}`, structuredClone(value));
      },
    },
  };
}

describe("WorkspaceHistory", () => {
  test("keeps newest first, de-duplicates, and caps each host", async () => {
    const { settings } = fakeSettings();
    const history = new WorkspaceHistory({ settings } as never);
    for (let i = 1; i <= 10; i++) await history.record("u", 1, `/p${i}`);
    await history.record("u", 1, "/p5");
    const list = await history.list("u", 1);
    expect(list).toHaveLength(8);
    expect(list[0]).toBe("/p5");
    expect(new Set(list).size).toBe(8);
  });

  test("is per user and per host", async () => {
    const { settings } = fakeSettings();
    const history = new WorkspaceHistory({ settings } as never);
    await history.record("a", 1, "/one");
    await history.record("a", 2, "/two");
    await history.record("b", 1, "/other");
    expect(await history.list("a", 1)).toEqual(["/one"]);
    expect(await history.list("a", 2)).toEqual(["/two"]);
    expect(await history.list("b", 1)).toEqual(["/other"]);
    expect(await history.list("c", 1)).toEqual([]);
  });

  test("simultaneous records do not lose entries", async () => {
    const { settings } = fakeSettings();
    const history = new WorkspaceHistory({ settings } as never);
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) => history.record("u", 1, `/p${i}`)),
    );
    expect((await history.list("u", 1)).sort()).toEqual([
      "/p1",
      "/p2",
      "/p3",
      "/p4",
      "/p5",
    ]);
  });

  test("forget removes one path and ignores unknown ones", async () => {
    const { settings } = fakeSettings();
    const history = new WorkspaceHistory({ settings } as never);
    await history.record("u", 1, "/a");
    await history.record("u", 1, "/b");
    await history.forget("u", 1, "/a");
    await history.forget("u", 1, "/never");
    expect(await history.list("u", 1)).toEqual(["/b"]);
    await history.forget("u", 1, "/b");
    expect(await history.list("u", 1)).toEqual([]);
  });

  test("drops the oldest hosts past the limit", async () => {
    const { settings, store } = fakeSettings();
    const history = new WorkspaceHistory({ settings } as never);
    for (let host = 1; host <= 55; host++)
      await history.record("u", host, "/x");
    const stored = store.get("u:recentWorkspaces") as Record<string, string[]>;
    expect(Object.keys(stored)).toHaveLength(50);
    expect(stored["1"]).toBeUndefined();
    expect(stored["55"]).toEqual(["/x"]);
  });

  test("ignores unusable paths and survives corrupt stored data", async () => {
    const { settings, store } = fakeSettings({
      "u:recentWorkspaces": "{not json",
    });
    const history = new WorkspaceHistory({ settings } as never);
    expect(await history.list("u", 1)).toEqual([]);
    await history.record("u", 1, "");
    await history.record("u", 1, "a\0b");
    expect(await history.list("u", 1)).toEqual([]);
    store.set("u:recentWorkspaces", {
      "1": ["/ok", 5, "a\0b", null],
      "2": "nope",
    });
    expect(await history.list("u", 1)).toEqual(["/ok"]);
    expect(await history.list("u", 2)).toEqual([]);
    store.set("u:recentWorkspaces", [1, 2]);
    expect(await history.list("u", 1)).toEqual([]);
  });
});
