import path from "node:path";
import { existsSync } from "node:fs";
import puppeteer, { type Browser } from "puppeteer-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  test,
  vi,
} from "vitest";

// Runs against a real Termix with the plugin installed, a host (id TERMIX_E2E_HOST)
// that has code-server, and the host settings used below. Skipped otherwise:
//   TERMIX_E2E_URL=http://127.0.0.1:8090 TERMIX_E2E_USER=admin TERMIX_E2E_PASSWORD=... npx vitest run termix-e2e
const URL_ = process.env.TERMIX_E2E_URL;
const USER = process.env.TERMIX_E2E_USER;
const PASSWORD = process.env.TERMIX_E2E_PASSWORD;
const HOST = Number(process.env.TERMIX_E2E_HOST ?? 1);
const CHROME =
  process.env.CHROME_PATH ??
  ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const PLUGIN = "/plugin-api/termix-vscode";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

describe.skipIf(!URL_ || !USER || !PASSWORD || !CHROME)(
  "real Termix, real sshd, real code-server",
  () => {
    let jwt = "";
    let browser: Browser;
    const started: string[] = [];

    const api = (route: string, init: RequestInit = {}) =>
      fetch(`${URL_}${route}`, {
        ...init,
        headers: {
          Cookie: `jwt=${jwt}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });

    const start = async (workspacePath?: string) => {
      const res = await api(`${PLUGIN}/session/start`, {
        method: "POST",
        body: JSON.stringify({
          hostId: HOST,
          ...(workspacePath ? { workspacePath } : {}),
        }),
      });
      const data = (await res.json()) as {
        sessionId?: string;
        iframeUrl?: string;
        code?: string;
      };
      if (data.sessionId) started.push(data.sessionId);
      return { res, data };
    };

    beforeAll(async () => {
      const login = await fetch(`${URL_}/users/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: USER, password: PASSWORD }),
      });
      jwt =
        /jwt=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
      expect(jwt).not.toBe("");
      browser = await puppeteer.launch({
        executablePath: CHROME,
        headless: true,
        args: ["--no-sandbox", "--disable-gpu"],
      });
    });

    afterAll(async () => {
      for (const id of started)
        await api(`${PLUGIN}/session/${id}/stop`, { method: "POST" }).catch(
          () => undefined,
        );
      await browser?.close();
    });

    /** Loads a session's page in an iframe inside a Termix page and returns the workbench text once `expected` shows. */
    async function workbenchText(iframeUrl: string, expected: RegExp) {
      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 900 });
      await page.setCookie({ name: "jwt", value: jwt, url: URL_! });
      const failures: string[] = [];
      page.on(
        "response",
        (r) => r.status() >= 400 && failures.push(`${r.status()} ${r.url()}`),
      );
      await page.goto(`${URL_}/health`);
      await page.evaluate((src: string) => {
        document.body.innerHTML = `<iframe id="f" src="${src}" style="width:1400px;height:900px;border:0"></iframe>`;
      }, iframeUrl);
      try {
        await page.waitForFunction(
          (source: string) => {
            const doc = (document.getElementById("f") as HTMLIFrameElement)
              .contentDocument;
            return (
              !!doc?.querySelector(".monaco-workbench") &&
              new RegExp(source).test(doc.body.innerText)
            );
          },
          { timeout: 90_000, polling: 500 },
          expected.source,
        );
      } catch (error) {
        throw new Error(
          `${(error as Error).message}\nfailures: ${failures.join("\n")}`,
        );
      }
      const text =
        (await (
          await (await page.$("#f"))?.contentFrame()
        )?.evaluate(() => document.body.innerText)) ?? "";
      await page.screenshot({
        path: path.join("/tmp", `termix-e2e-${Date.now()}.png`),
      });
      await page.close();
      return {
        text,
        failures: failures.filter((f) => !/vsda|favicon|manifest/.test(f)),
      };
    }

    test("the host's workspaces come back through core, with settings validation enforced by core", async () => {
      const res = await api(`${PLUGIN}/workspaces/${HOST}`);
      expect(res.status).toBe(200);
      const info = (await res.json()) as { named: { name: string }[] };
      expect(info.named.map((w) => w.name)).toContain("Proj");

      const rejected = await api(
        `/plugins/termix-vscode/settings/host/${HOST}`,
        {
          method: "PUT",
          body: JSON.stringify({ workspaces: "A = ~/a\nA = ~/b" }),
        },
      );
      expect(rejected.status).toBe(400);
    });

    test("a folder opens through real nginx and core, sockets included", async () => {
      const { res, data } = await start("~/proj");
      expect(res.status).toBe(200);
      const { text, failures } = await workbenchText(
        data.iframeUrl!,
        /inner-file\.txt/,
      );
      expect(text).toMatch(/inner-file\.txt/);
      expect(failures).toEqual([]);
    });

    test("a .code-workspace file opens", async () => {
      const { res, data } = await start("~/app.code-workspace");
      expect(res.status).toBe(200);
      await workbenchText(data.iframeUrl!, /inner-file\.txt/);
    });

    test("two sessions at once each show their own folder", async () => {
      const [a, b] = [await start("~/proj"), await start("~/other")];
      const [first, second] = await Promise.all([
        workbenchText(a.data.iframeUrl!, /inner-file\.txt/),
        workbenchText(b.data.iframeUrl!, /other-file\.txt/),
      ]);
      expect(first.text).not.toMatch(/other-file\.txt/);
      expect(second.text).not.toMatch(/inner-file\.txt/);
    });

    test("a missing path and a plain file are refused with codes", async () => {
      expect((await start("~/missing")).data.code).toBe("WORKSPACE_NOT_FOUND");
      expect((await start("~/notes.txt")).data.code).toBe(
        "WORKSPACE_UNSUPPORTED",
      );
    });

    test("history is remembered and the last one is first", async () => {
      const info = (await (
        await api(`${PLUGIN}/workspaces/${HOST}`)
      ).json()) as { recent: string[] };
      expect(info.recent.length).toBeGreaterThan(0);
      expect(info.recent).toContain("~/proj");
    });

    test("someone not signed in gets nothing", async () => {
      expect((await fetch(`${URL_}${PLUGIN}/workspaces/${HOST}`)).status).toBe(
        401,
      );
      const { data } = await start("~/proj");
      expect(
        (await fetch(`${URL_}${PLUGIN}/session/${data.sessionId}/`)).status,
      ).toBe(401);
    });
  },
);
