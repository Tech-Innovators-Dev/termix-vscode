import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import puppeteer, { type Browser } from "puppeteer-core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { activate } from "../../src/backend/index.js";
import { startCoreHost, type CoreHost } from "./support/core-host.js";
import { FakeSshServer } from "./support/fake-ssh.js";

const CHROME =
  process.env.CHROME_PATH ??
  [
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].find(existsSync);
const STUB = path.resolve(import.meta.dirname, "support/stub-code-server");
const PLUGIN = "/plugin-api/termix-vscode";

describe.skipIf(!CHROME)("in a real browser", () => {
  let browser: Browser;
  let ssh: FakeSshServer;
  let core: CoreHost;
  let sessionId: string;

  beforeAll(async () => {
    ssh = new FakeSshServer(mkdtempSync(path.join(tmpdir(), "vsc-br-")));
    await ssh.listen();
    core = await startCoreHost({
      ssh,
      users: { tok: "alice" },
      hostSettings: { "1:vscodePath": STUB },
      activate,
    });
    const res = await fetch(`${core.baseUrl}${PLUGIN}/session/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: "jwt=tok" },
      body: JSON.stringify({ hostId: 1 }),
    });
    sessionId = ((await res.json()) as { sessionId: string }).sessionId;
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ["--no-sandbox", "--disable-gpu"],
    });
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await core?.disposeAll();
    await core?.close();
    await ssh?.close();
  });

  async function openPage(block?: RegExp) {
    const page = await browser.newPage();
    await page.setCookie({ name: "jwt", value: "tok", url: core.baseUrl });
    if (block) {
      await page.setRequestInterception(true);
      page.on("request", (request) =>
        block.test(request.url()) ? request.abort() : request.continue(),
      );
    }
    // A Termix-like outer page, with the workspace in an iframe as the tab does.
    await page.goto(`${core.baseUrl}${PLUGIN}/session/${sessionId}/asset.js`);
    await page.evaluate((src: string) => {
      document.body.innerHTML = `<iframe id="f" src="${src}" style="width:600px;height:400px"></iframe>`;
    }, `${PLUGIN}/session/${sessionId}/`);
    const frameTitle = () =>
      page.evaluate(
        () =>
          (document.getElementById("f") as HTMLIFrameElement).contentDocument
            ?.title ?? "",
      );
    return { page, frameTitle };
  }

  test("code-server's page, in an iframe, talks through the rewritten socket", async () => {
    const { page, frameTitle } = await openPage();
    await page.waitForFunction(
      () =>
        (document.getElementById("f") as HTMLIFrameElement).contentDocument
          ?.title === "ws:echo:hello",
      { timeout: 15_000 },
    );
    expect(await frameTitle()).toBe("ws:echo:hello");
    await page.close();
  }, 30_000);

  test("without the shim the same page cannot connect (the shim is what makes it work)", async () => {
    const { page, frameTitle } = await openPage(/ws-shim\.js$/);
    // The shim is blocked for the iframe only; the outer page is another plain asset.
    await page.waitForFunction(
      () =>
        (document.getElementById("f") as HTMLIFrameElement).contentDocument
          ?.title === "ws-error",
      { timeout: 15_000 },
    );
    expect(await frameTitle()).toBe("ws-error");
    await page.close();
  }, 30_000);

  test("another user's browser cannot open the page or the socket", async () => {
    const page = await browser.newPage();
    await page.setCookie({ name: "jwt", value: "nope", url: core.baseUrl });
    const response = await page.goto(
      `${core.baseUrl}${PLUGIN}/session/${sessionId}/`,
    );
    expect(response?.status()).toBe(401);
    await page.close();
  });
});
