import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { build } from "esbuild";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";

test("real Electron browser input, isolated native X11 application and usable control panel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-computer-gui-"));
  const bundle = join(dir, "control-host.cjs");
  await build({
    entryPoints: ["tests/fixtures/computer-host.ts"],
    outfile: bundle,
    platform: "node",
    format: "cjs",
    bundle: true,
    external: ["electron"],
  });
  const fixture = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      "<!doctype html><title>Harbour QA Desk</title><style>body{font:20px sans-serif;padding:40px}input,button{padding:20px;font:inherit}</style><h1>Vehicle notebook</h1><input aria-label=\"Query\"><button onclick=\"document.querySelector('output').textContent=document.querySelector('input').value\">Apply</button><p><output>Not applied</output></p>",
    );
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as any).port}`;
  let app: ElectronApplication | undefined,
    target: ElectronApplication | undefined,
    wm: ChildProcess | undefined;
  try {
    // Xvfb alone is not an interactive desktop: Chromium enumerates managed
    // windows, not arbitrary X resources. Optional real WM, QA display only.
    if (process.env.SYNORA_QA_WINDOW_MANAGER) {
      wm = spawn(
        process.env.SYNORA_QA_WINDOW_MANAGER,
        ["-f", resolve("tests/fixtures/computer-twm.conf")],
        { stdio: "ignore" },
      );
      await new Promise((r) => setTimeout(r, 250));
      expect(wm.exitCode).toBe(null);
    }
    app = await _electron.launch({
      args: [".", "--disable-gpu"],
      chromiumSandbox: true,
      env: {
        ...process.env,
        SYNORA_DATA_DIR: join(dir, "state"),
        ...(process.env.SYNORA_TEST_CORE
          ? { SYNORA_CODEX_BINARY: process.env.SYNORA_TEST_CORE }
          : {}),
      },
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("heading", { name: "A space for focused work." }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Computer & browser", exact: true })
      .click();
    const panel = page.getByRole("complementary", {
      name: "Computer & browser",
    });
    await expect(panel).toBeVisible();
    await panel.getByLabel("Internal browser", { exact: true }).click();
    await expect(
      panel.getByLabel("Internal browser", { exact: true }),
    ).toBeChecked();
    for (const size of [
      { width: 1440, height: 900 },
      { width: 1024, height: 700 },
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) =>
          BrowserWindow.getAllWindows()[0].setSize(size.width, size.height),
        size,
      );
      await expect(
        panel.getByRole("button", { name: "Stop control", exact: true }),
      ).toBeVisible();
      if (size.width === 1440) {
        const before = (await panel.boundingBox())!.width;
        await panel
          .getByRole("separator", { name: "Resize browser panel" })
          .press("ArrowLeft");
        await expect
          .poll(async () => (await panel.boundingBox())!.width)
          .toBeGreaterThan(before);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/computer-control/panel-${size.width}.png`,
      });
    }
    await panel
      .getByRole("button", { name: "Stop control", exact: true })
      .click();
    await expect(
      panel.getByLabel("Internal browser", { exact: true }),
    ).not.toBeChecked();
    await panel.getByRole("button", { name: "Close panel" }).click();
    await page.getByRole("button", { name: "Browser", exact: true }).click();
    await page.getByLabel("Browser address").fill(url);
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.locator(".tabs")).toContainText("Harbour QA Desk");
    await page
      .getByRole("button", { name: "Computer & browser", exact: true })
      .click();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.every(
            (v) => !v.getVisible(),
          ),
        ),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(1440, 900),
    );
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5),
    );
    await expect(
      panel.getByRole("button", { name: "Close panel" }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: "test-results/computer-control/panel-zoom-150.png",
    });
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1),
    );
    await page.evaluate(() => window.synora.preferences({ theme: "dark" }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(
      page.locator(".browser-surface img.remote-browser"),
    ).toBeVisible();
    await page.screenshot({
      path: "test-results/computer-control/panel-dark.png",
    });
    await panel.getByRole("button", { name: "Close panel" }).click();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await app.evaluate(({ BrowserWindow }, bundle) => {
      const mod = process.getBuiltinModule("module").createRequire(bundle)(
        bundle,
      );
      (globalThis as any).qaNative = new mod.NativeComputer();
      (globalThis as any).qaBrowser = new mod.Browser(
        BrowserWindow.getAllWindows()[0],
        () => {},
      );
    }, bundle);
    const tabs: any = await app.evaluate(
      async (_e, url) => (globalThis as any).qaBrowser.open(url),
      url,
    );
    const id = tabs[0].id;
    await expect
      .poll(() =>
        app!.evaluate(
          (_e, id) =>
            (globalThis as any).qaBrowser.list().find((t: any) => t.id === id)
              .loading,
          id,
        ),
      )
      .toBe(false);
    const observed: any = await app.evaluate(
      (_e, id) => (globalThis as any).qaBrowser.inspect(id),
      id,
    );
    const input = observed.elements.find((e: any) => e.name === "Query");
    await app.evaluate(
      async (_e, { id, input }) => {
        const b = (globalThis as any).qaBrowser;
        await b.input(id, {
          type: "click",
          x: input.click.x,
          y: input.click.y,
          button: "left",
        });
        await b.input(id, { type: "text", text: "Real internal browser" });
        await b.input(id, { type: "key", key: "Tab" });
        await b.input(id, { type: "key", key: "Enter" });
      },
      { id, input },
    );
    await expect
      .poll(() =>
        app!.evaluate(
          async (_e, id) =>
            (await (globalThis as any).qaBrowser.inspect(id)).text,
          id,
        ),
      )
      .toContain("Real internal browser");
    const frame: any = await app.evaluate(
      (_e, id) => (globalThis as any).qaBrowser.frame(id),
      id,
    );
    expect(frame.width).toBe(1000);
    expect(frame.dataURL.length).toBeGreaterThan(1000);

    target = await _electron.launch({
      args: [resolve("tests/fixtures/computer-target.cjs"), "--disable-gpu"],
      chromiumSandbox: true,
      env: { ...process.env, SYNORA_QA_PAGE: url },
    });
    const targetPage = await target.firstWindow();
    await expect(
      targetPage.getByRole("heading", { name: "Vehicle notebook" }),
    ).toBeVisible();
    const supported: any = await app.evaluate(() =>
      (globalThis as any).qaNative.status(),
    );
    expect(supported.supported, JSON.stringify(supported)).toBe(true);
    const windows: any[] = await app.evaluate(() =>
      (globalThis as any).qaNative.windows(AbortSignal.timeout(5000)),
    );
    const window = windows.find((w) => w.title === "Harbour QA Desk");
    expect(window, JSON.stringify(windows)).toBeTruthy();
    const nativeFrame: any = await app.evaluate(
      (_e, id) =>
        (globalThis as any).qaNative.capture(id, AbortSignal.timeout(5000)),
      window.id,
    );
    await writeFile(
      "test-results/computer-control/native-before.jpg",
      Buffer.from(nativeFrame.dataURL.split(",")[1], "base64"),
    );
    const point = await targetPage.getByLabel("Query").boundingBox();
    expect(point).toBeTruthy();
    const bounds = await target.evaluate(({ BrowserWindow }) => ({
      window: BrowserWindow.getAllWindows()[0].getBounds(),
      content: BrowserWindow.getAllWindows()[0].getContentBounds(),
    }));
    console.log(
      "Native frame/target bounds",
      nativeFrame.width,
      nativeFrame.height,
      bounds,
      point,
    );
    const x =
      ((point!.x + point!.width / 2 + bounds.content.x - bounds.window.x) *
        nativeFrame.width) /
      bounds.window.width;
    const y =
      ((point!.y + point!.height / 2 + bounds.content.y - bounds.window.y) *
        nativeFrame.height) /
      bounds.window.height;
    await app.evaluate(
      async (_e, { id, frame, x, y }) => {
        const n = (globalThis as any).qaNative;
        await n.input(
          id,
          { type: "click", x, y, button: "left" },
          frame,
          AbortSignal.timeout(12000),
        );
        await n.input(
          id,
          { type: "text", text: "Native input · Lazio" },
          frame,
          AbortSignal.timeout(12000),
        );
        await n.input(
          id,
          { type: "key", key: "Tab" },
          frame,
          AbortSignal.timeout(12000),
        );
        await n.input(
          id,
          { type: "key", key: "Enter" },
          frame,
          AbortSignal.timeout(12000),
        );
      },
      { id: window.id, frame: nativeFrame, x, y },
    );
    console.log(
      "Observed input after real X11 events",
      await targetPage.getByLabel("Query").inputValue(),
    );
    await expect(targetPage.locator("output")).toHaveText(
      "Native input · Lazio",
    );
    await targetPage.screenshot({
      path: "test-results/computer-control/native-actual-result.png",
    });
    const grant = await page.evaluate(async () => {
      const state = await window.synora.state();
      if (!state.ok) throw Error(state.error.message);
      return window.synora.controlConfigure({
        conversationId: state.value.conversations[0].id,
        browser: true,
        computer: false,
      });
    });
    expect(grant.ok).toBe(true);
    // This is the operator emergency shortcut on our isolated X11 display,
    // not a hotkey available to the model's computer_action schema.
    execFileSync("xdotool", ["key", "ctrl+shift+F12"]);
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const state = await window.synora.controlStatus();
          return state.ok ? state.value.grant : "status failed";
        }),
      )
      .toBe(null);
    await app.evaluate(() => (globalThis as any).qaBrowser.dispose());
    expect(errors).toEqual([]);
  } finally {
    await target?.close();
    await app?.close();
    wm?.kill();
    await new Promise<void>((r) => fixture.close(() => r()));
  }
});
