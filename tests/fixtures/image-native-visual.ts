import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";

export async function qualifyImageVisual(
  app: ElectronApplication,
  page: Page,
  path: string,
) {
  const content = await app.evaluate(({ BrowserWindow, screen }) => {
    const win = BrowserWindow.getAllWindows()[0],
      outer = win.getBounds(),
      inner = win.getContentBounds();
    const area = screen.getDisplayMatching(outer).workArea;
    const size = [
      Math.min(1280, area.width - outer.width + inner.width),
      Math.min(1000, area.height - outer.height + inner.height),
    ];
    win.setContentSize(size[0], size[1]);
    win.webContents.setZoomFactor(1.5);
    return size;
  });
  await expect
    .poll(() =>
      page.evaluate(
        (width) =>
          innerWidth >= Math.floor(width / 1.5) &&
          innerWidth <= Math.ceil(width / 1.5),
        content[0],
      ),
    )
    .toBe(true);
  const image = page.locator(".message.user img");
  await image.scrollIntoViewIfNeeded();
  await expect(image).toBeVisible();
  const geometry = await image.evaluate((img) => {
    const r = img.getBoundingClientRect();
    return {
      left: r.left,
      right: r.right,
      top: r.top,
      bottom: r.bottom,
      width: innerWidth,
      height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0);
  expect(geometry.right).toBeLessThanOrEqual(geometry.width);
  expect(geometry.top).toBeGreaterThanOrEqual(0);
  expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
  expect(geometry.overflow).toBe(false);
  // Native pixels, not a CDP clip in CSS pixels at non-unit Electron zoom.
  const capture = await app.evaluate(async ({ BrowserWindow }) =>
    (await BrowserWindow.getAllWindows()[0].capturePage())
      .toPNG()
      .toString("base64"),
  );
  await writeFile(path, Buffer.from(capture, "base64"));
  return { content, geometry, path };
}
