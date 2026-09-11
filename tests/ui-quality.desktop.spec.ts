import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { qualifyDialogs, qualifyLayout } from "./ui-quality-workflow";

test("Native UI: dialog/input focus, window resize, zoom and browser layering", async ({}, info) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-native-ui-quality-"));
  const fixture = createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end(
      '<!doctype html><title>Synora layout fixture</title><h1>Native browser content</h1><input aria-label="Remote field">',
    );
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  let app: ElectronApplication | undefined;
  const errors: string[] = [];
  try {
    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: process.env.SYNORA_TEST_EXECUTABLE
        ? ["--disable-gpu"]
        : [".", "--disable-gpu"],
      chromiumSandbox: true,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_DATA_DIR: dir },
    });
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("heading", { name: "A space for focused work." }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(true);
    // Capture native pixel dimensions; CDP's screenshot clip uses CSS dimensions
    // at non-unit Electron zoom and can crop otherwise-correct window contents.
    const capture = async () => {
      const data = await app!.evaluate(async ({ BrowserWindow }) =>
        (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL(),
      );
      return Buffer.from(data.slice(data.indexOf(",") + 1), "base64");
    };
    for (const [width, height, zoom] of [
      [1480, 960, 1],
      [900, 640, 1],
      [1480, 960, 1.5],
      [1000, 740, 1.5],
    ]) {
      const fitted = await app.evaluate(
        ({ BrowserWindow, screen }, size) => {
          const window = BrowserWindow.getAllWindows()[0];
          const outer = window.getBounds(),
            inner = window.getContentBounds();
          const area = screen.getDisplayMatching(outer).workArea;
          const content = [
            Math.min(size[0], area.width - (outer.width - inner.width)),
            Math.min(size[1], area.height - (outer.height - inner.height)),
          ];
          window.setContentSize(content[0], content[1]);
          window.webContents.setZoomFactor(size[2]);
          return { content, area, requested: size };
        },
        [width, height, zoom],
      );
      await expect
        .poll(() =>
          app!.evaluate(({ BrowserWindow }) =>
            BrowserWindow.getAllWindows()[0].getContentSize(),
          ),
        )
        .toEqual(fitted.content);
      await info.attach(`native-display-${width}x${height}-zoom-${zoom}`, {
        body: Buffer.from(JSON.stringify(fitted)),
        contentType: "application/json",
      });
      // innerWidth is an integer CSS-pixel value. Retina macOS truncates this
      // fractional viewport while Linux rounds it. Native content size above
      // and exact child bounds below remain strict; no layout tolerance added.
      await expect
        .poll(() =>
          page.evaluate(
            ({ width, zoom }) =>
              Number.isInteger(innerWidth) &&
              innerWidth >= Math.floor(width / zoom) &&
              innerWidth <= Math.ceil(width / zoom),
            { width: fitted.content[0], zoom },
          ),
        )
        .toBe(true);
      await qualifyDialogs(page, info, capture);
      await qualifyLayout(page, info, capture);
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      await page.getByLabel("Browser address").fill(url);
      await page.getByRole("button", { name: "Go", exact: true }).click();
      await expect(page.locator(".tabs")).toContainText(
        "Synora layout fixture",
      );
      const expected = await page
        .locator(".browser-surface")
        .evaluate((el, scale) => {
          const r = el.getBoundingClientRect();
          return {
            x: Math.round(r.x * scale),
            y: Math.round(r.y * scale),
            width: Math.round(r.width * scale),
            height: Math.round(r.height * scale),
          };
        }, zoom);
      await expect
        .poll(() =>
          app!.evaluate(({ BrowserWindow }) => {
            const child =
              BrowserWindow.getAllWindows()[0].contentView.children.find((v) =>
                v.getVisible(),
              );
            return child?.getBounds();
          }),
        )
        .toEqual(expected);
      // WebContentsView is a separate Chromium surface. Main-window captures
      // do not include it consistently across compositors (notably macOS).
      // Qualify the real remote page and retain its unmodified pixels as
      // separate evidence; never synthesize a composite screenshot.
      await expect
        .poll(() =>
          app!
            .context()
            .pages()
            .some((p) => p.url() === url + "/"),
        )
        .toBe(true);
      const remote = app
        .context()
        .pages()
        .find((p) => p.url() === url + "/")!;
      await expect(
        remote.getByRole("heading", { name: "Native browser content" }),
      ).toBeVisible();
      await remote
        .getByRole("textbox", { name: "Remote field" })
        .fill(`SYNORA_BROWSER_${zoom}`);
      await expect(
        remote.getByRole("textbox", { name: "Remote field" }),
      ).toHaveValue(`SYNORA_BROWSER_${zoom}`);
      await remote.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const childCapture = await app.evaluate(
        async ({ webContents }, target) => {
          const wc = webContents
            .getAllWebContents()
            .find((w) => w.getURL() === target)!;
          const capture = await wc.capturePage();
          return {
            size: capture.getSize(),
            empty: capture.isEmpty(),
            png: capture.toPNG().toString("base64"),
          };
        },
        url + "/",
      );
      expect(childCapture.empty).toBe(false);
      expect(childCapture.size.width).toBeGreaterThan(100);
      expect(childCapture.size.height).toBeGreaterThan(50);
      await info.attach(`native-browser-page-${width}x${height}-zoom-${zoom}`, {
        body: Buffer.from(childCapture.png, "base64"),
        contentType: "image/png",
      });
      await info.attach(`native-browser-${width}x${height}-zoom-${zoom}`, {
        body: await capture(),
        contentType: "image/png",
      });
      await page.getByRole("button", { name: "Bots", exact: true }).click();
      await page.getByRole("button", { name: "New bot", exact: true }).click();
      await expect(page.getByRole("dialog")).toBeVisible();
      expect(
        await app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].contentView.children.some((v) =>
            v.getVisible(),
          ),
        ),
      ).toBe(false);
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "Browser", exact: true }).click();
      await page
        .getByRole("button", { name: "Close browser tab", exact: true })
        .click();
    }
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await new Promise<void>((r, j) => fixture.close((e) => (e ? j(e) : r())));
    await rm(dir, { recursive: true, force: true });
  }
});
