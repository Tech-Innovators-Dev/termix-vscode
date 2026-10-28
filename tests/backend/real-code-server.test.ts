import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { activate } from "../../src/backend/index.js";
import { startCoreHost, type CoreHost } from "./support/core-host.js";
import { FakeSshServer } from "./support/fake-ssh.js";

// Set CODE_SERVER_BIN to a real code-server to run this; it is skipped otherwise.
// vsda (Microsoft's signing helper) is absent from stock code-server and 404s by design.
const BIN = process.env.CODE_SERVER_BIN;
const CHROME =
  process.env.CHROME_PATH ??
  ["/usr/bin/google-chrome", "/usr/bin/chromium"].find(existsSync);
const PLUGIN = "/plugin-api/termix-vscode";

describe.skipIf(!BIN || !CHROME)("real code-server through the plugin", () => {
  let browser: Browser;
  let ssh: FakeSshServer;
  let core: CoreHost;
  let home: string;
  let sessionId: string;
  const sockets: string[] = [];

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), "vsc-real-"));
    writeFileSync(path.join(home, "hello.txt"), "hello from the host\n");
    mkdirSync(path.join(home, "proj"));
    writeFileSync(
      path.join(home, "proj", "inner-file.txt"),
      "inside the project\n",
    );
    writeFileSync(
      path.join(home, "proj", "app.code-workspace"),
      JSON.stringify({ folders: [{ path: "." }] }),
    );
    writeFileSync(path.join(home, "notes.txt"), "NOTES-CONTENT-XYZ\n");
    mkdirSync(path.join(home, "other"));
    writeFileSync(path.join(home, "other", "other-file.txt"), "elsewhere\n");
    ssh = new FakeSshServer(home);
    await ssh.listen();
    core = await startCoreHost({
      ssh,
      users: { tok: "alice" },
      hostSettings: { "1:vscodePath": BIN!, "1:defaultWorkspace": "~" },
      activate,
    });
    const res = await fetch(`${core.baseUrl}${PLUGIN}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "jwt=tok" },
      body: JSON.stringify({ hostId: 1 }),
    });
    expect(res.status).toBe(200);
    sessionId = ((await res.json()) as { sessionId: string }).sessionId;
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await core?.disposeAll();
    await core?.close();
    await ssh?.close();
  });

  test("the workbench loads in an iframe, connects over the rewritten socket and opens the workspace", async () => {
    const page = await browser.newPage();
    await page.setCookie({ name: "jwt", value: "tok", url: core.baseUrl });
    const failures: string[] = [];
    page.on("requestfailed", (r) =>
      failures.push(`${r.url()} ${r.failure()?.errorText}`),
    );
    page.on(
      "response",
      (r) => r.status() >= 400 && failures.push(`${r.status()} ${r.url()}`),
    );
    const cdp = await page.createCDPSession();
    await cdp.send("Network.enable");
    cdp.on("Network.webSocketCreated", (e) => sockets.push(e.url));

    await page
      .goto(`${core.baseUrl}${PLUGIN}/session/${sessionId}/asset.js`)
      .catch(() => undefined);
    await page.evaluate((src: string) => {
      document.body.innerHTML = `<iframe id="f" src="${src}" style="width:1200px;height:800px;border:0"></iframe>`;
    }, `${PLUGIN}/session/${sessionId}/`);

    const frame = async () => {
      const handle = await page.$("#f");
      return handle?.contentFrame();
    };
    // The explorer lists the file only after the workbench has a working remote connection.
    await page
      .waitForFunction(
        () => {
          const doc = (document.getElementById("f") as HTMLIFrameElement)
            .contentDocument;
          return (
            !!doc?.querySelector(".monaco-workbench") &&
            /hello\.txt/.test(doc.body.innerText)
          );
        },
        { timeout: 90_000, polling: 500 },
      )
      .catch(async (error) => {
        const doc = await (
          await frame()
        )?.evaluate(() => document.body?.innerText.slice(0, 500));
        throw new Error(
          `${error.message}\nframe text: ${doc}\nfailures: ${failures.join("\n")}\nsockets: ${sockets.join("\n")}`,
        );
      });

    expect(sockets.length).toBeGreaterThan(0);
    for (const url of sockets)
      expect(url).toContain("/plugin-ws/termix-vscode/vscode?s=");
    expect(
      failures.filter((f) => !/favicon|manifest|\/asset\.js|vsda/.test(f)),
    ).toEqual([]);
    await page.screenshot({ path: path.join(home, "workbench.png") });
    console.log("screenshot:", path.join(home, "workbench.png"));
    await page.close();
  }, 120_000);

  // What each kind of target shows once the workbench is up.
  const TARGETS: Array<[string, string, RegExp]> = [
    ["a folder", "~/proj", /inner-file\.txt/],
    ["a .code-workspace file", "~/proj/app.code-workspace", /inner-file\.txt/],
  ];

  for (const [label, workspacePath, expected] of TARGETS) {
    test(`opens ${label} (${workspacePath}) chosen at start`, async () => {
      const res = await fetch(`${core.baseUrl}${PLUGIN}/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "jwt=tok" },
        body: JSON.stringify({ hostId: 1, workspacePath }),
      });
      expect(res.status).toBe(200);
      const { sessionId: id } = (await res.json()) as { sessionId: string };

      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 900 });
      await page.setCookie({ name: "jwt", value: "tok", url: core.baseUrl });
      await page
        .goto(`${core.baseUrl}${PLUGIN}/session/${id}/asset.js`)
        .catch(() => undefined);
      await page.evaluate((src: string) => {
        document.body.innerHTML = `<iframe id="f" src="${src}" style="width:1400px;height:900px;border:0"></iframe>`;
      }, `${PLUGIN}/session/${id}/`);
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
        const text = await (
          await (await page.$("#f"))?.contentFrame()
        )?.evaluate(() => document.body?.innerText.slice(0, 400));
        throw new Error(`${(error as Error).message}\nframe text: ${text}`);
      } finally {
        await page.screenshot({
          path: path.join(home, `target-${label.replace(/\W+/g, "-")}.png`),
        });
        await page.close();
        await fetch(`${core.baseUrl}${PLUGIN}/session/${id}/stop`, {
          method: "POST",
          headers: { Cookie: "jwt=tok" },
        });
      }
    }, 150_000);
  }

  test("two sessions on one host at once each open their own folder", async () => {
    const begin = async (workspacePath: string) => {
      const res = await fetch(`${core.baseUrl}${PLUGIN}/session/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: "jwt=tok" },
        body: JSON.stringify({ hostId: 1, workspacePath }),
      });
      expect(res.status, workspacePath).toBe(200);
      return ((await res.json()) as { sessionId: string }).sessionId;
    };
    const [one, two] = [await begin("~/proj"), await begin("~/other")];

    const textOf = async (id: string, expected: RegExp) => {
      const page = await browser.newPage();
      await page.setViewport({ width: 1400, height: 900 });
      await page.setCookie({ name: "jwt", value: "tok", url: core.baseUrl });
      await page
        .goto(`${core.baseUrl}${PLUGIN}/session/${id}/asset.js`)
        .catch(() => undefined);
      await page.evaluate((src: string) => {
        document.body.innerHTML = `<iframe id="f" src="${src}" style="width:1400px;height:900px;border:0"></iframe>`;
      }, `${PLUGIN}/session/${id}/`);
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
      const text = await (
        await (await page.$("#f"))?.contentFrame()
      )?.evaluate(() => document.body.innerText);
      await page.close();
      return text ?? "";
    };

    try {
      const [first, second] = await Promise.all([
        textOf(one, /inner-file\.txt/),
        textOf(two, /other-file\.txt/),
      ]);
      expect(first).not.toMatch(/other-file\.txt/);
      expect(second).not.toMatch(/inner-file\.txt/);
    } finally {
      for (const id of [one, two]) {
        await fetch(`${core.baseUrl}${PLUGIN}/session/${id}/stop`, {
          method: "POST",
          headers: { Cookie: "jwt=tok" },
        });
      }
    }
  }, 180_000);

  test("a single file is refused rather than opening an empty window", async () => {
    const res = await fetch(`${core.baseUrl}${PLUGIN}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "jwt=tok" },
      body: JSON.stringify({ hostId: 1, workspacePath: "~/notes.txt" }),
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe(
      "WORKSPACE_UNSUPPORTED",
    );
  });
});
