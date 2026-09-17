import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_CORE_VERSION } from "../src/engine/core-runtime";
import { qualificationRuntime } from "./fixtures/qualification-runtime";
test("Native IPC update settings, qualification gate, persistence and 150% layout", async ({}, info) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "synora-update-native-"));
  const launch = () =>
    _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: process.env.SYNORA_TEST_EXECUTABLE
        ? ["--disable-gpu"]
        : [".", "--disable-gpu"],
      chromiumSandbox: true,
      env: { ...process.env, SYNORA_DATA_DIR: root },
      cwd: process.cwd(),
    });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await qualificationRuntime(page);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    let card = page.getByRole("article", { name: "App Server updates" });
    await expect(card).toContainText(BUNDLED_CORE_VERSION);
    await expect(
      card.getByRole("button", { name: "Update App Server", exact: true }),
    ).toBeDisabled();
    await card
      .getByRole("checkbox", { name: "Automatically check App Server updates" })
      .uncheck();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const s = await window.synora.coreUpdateStatus();
          return s.ok && s.value.automatic;
        }),
      )
      .toBe(false);
    const rejected = await page.evaluate(() =>
      window.synora.coreUpdateInstall("9.9.9"),
    );
    expect(rejected.ok).toBe(false);
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    card = page.getByRole("article", { name: "App Server updates" });
    await expect(
      card.getByRole("checkbox", {
        name: "Automatically check App Server updates",
      }),
    ).not.toBeChecked();
    await expect
      .poll(() =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(true);
    await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(1000, 740);
      w.webContents.setZoomFactor(1.5);
    });
    await expect.poll(() => page.evaluate(() => innerWidth)).toBeLessThan(700);
    await card
      .getByRole("button", { name: "Check for App Server updates" })
      .scrollIntoViewIfNeeded();
    await expect(
      card.getByRole("button", { name: "Check for App Server updates" }),
    ).toBeInViewport({ ratio: 1 });
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth + 1,
        ),
      )
      .toBe(true);
    await info.attach("updater-native-150", {
      body: await app
        .evaluate(async ({ BrowserWindow }) =>
          Array.from(
            (await BrowserWindow.getAllWindows()[0].capturePage()).toPNG(),
          ),
        )
        .then((v) => Buffer.from(v)),
      contentType: "image/png",
    });
  } finally {
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
