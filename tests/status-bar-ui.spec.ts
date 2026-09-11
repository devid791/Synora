import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let script: string, css: string;
test.beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["tests/fixtures/status-bar-ui.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  css = (await readFile("src/renderer/style.css", "utf8")).replace(
    /^@import.*$/gm,
    "",
  );
});
async function mount(
  page: Page,
  width = 1440,
  locale = "en",
  theme = "dark",
  zoom = 1,
) {
  await page.route("**/*", (route) => route.abort());
  await page.clock.install();
  await page.setViewportSize({ width, height: 900 });
  await page.setContent(
    `<html data-theme="${theme}"><body><div id="root"></div></body></html>`,
  );
  await page.evaluate(
    ({ locale, zoom }) => {
      (window as any).testLocale = locale;
      document.documentElement.style.zoom = String(zoom);
    },
    { locale, zoom },
  );
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: script });
  await expect(page.locator(".status-gpu [data-gpu-live]")).toHaveCount(1);
}
const detailsButton = (page: Page) => page.locator(".status-details-button");
async function tick(page: Page, ms = 2000) {
  await page.clock.runFor(ms);
}

for (const locale of ["en", "it", "fr", "de", "es", "pt", "nl"])
  for (const width of [1440, 390])
    test(`Grouped bar and accessible details: ${locale}, ${width}px`, async ({
      page,
    }, info) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await mount(page, width, locale, width === 390 ? "light" : "dark");
      const bar = page.locator("footer.status-bar");
      const box = (await bar.boundingBox())!;
      expect(box.height).toBeLessThanOrEqual(width > 620 ? 42 : 66);
      expect(await bar.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(
        true,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(
        page.locator(".status-connection .app-server-status"),
      ).toBeVisible();
      await expect(page.locator(".status-activity-label")).toBeVisible();
      await expect(page.locator(".status-gpu")).toBeVisible();
      await expect(page.locator("dialog")).toHaveCount(0);
      // Each visible group is wholly within the footer; none overlaps its neighbor.
      const groups = await page
        .locator(
          ".status-connection, .status-activity, .status-gpu, .status-details-button",
        )
        .evaluateAll((elements) =>
          elements.map((el) => {
            const r = el.getBoundingClientRect();
            return { x: r.x, y: r.y, right: r.right, bottom: r.bottom };
          }),
        );
      for (const a of groups) {
        expect(a.x).toBeGreaterThanOrEqual(box.x);
        expect(a.right).toBeLessThanOrEqual(box.x + box.width);
        for (const b of groups)
          if (a !== b)
            expect(
              a.right <= b.x ||
                b.right <= a.x ||
                a.bottom <= b.y ||
                b.bottom <= a.y,
            ).toBe(true);
      }
      if (locale === "it")
        await bar.screenshot({ path: info.outputPath(`bar-${width}.png`) });
      await detailsButton(page).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expect(dialog.locator("section")).toHaveCount(4);
      await expect(dialog).toContainText("NVIDIA GeForce RTX 5090");
      await expect(dialog).toContainText("0.153.4 · darwin");
      await expect(dialog).toContainText("PTY 2");
      const panel = (await dialog.boundingBox())!;
      expect(panel.x).toBeGreaterThanOrEqual(0);
      expect(panel.x + panel.width).toBeLessThanOrEqual(width);
      expect(
        await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      if (locale === "it")
        await dialog.screenshot({
          path: info.outputPath(`details-${width}.png`),
        });
      expect(errors).toEqual([]);
    });

test("Recovered incomplete history never ticks as if it were still running", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).patchEngine({ status: "disconnected",
    startedAt: 100000, completedAt: undefined, firstDeltaAt: undefined }));
  const before = await page.locator(".status-activity").innerText();
  await tick(page, 5000);
  expect(await page.locator(".status-activity").innerText()).toBe(before);
  await detailsButton(page).click();
  await expect(page.getByRole("dialog").locator("[data-turn-detail]")).not.toContainText(/\d+\.\d+s/);
});
test("Live activity changes immediately; all historical counters stay in labeled details", async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator("footer")).not.toContainText("450,000");
  await page.evaluate(() =>
    (window as any).patchEngine({
      status: "running",
      completedAt: undefined,
      turnId: "next-turn",
    }),
  );
  await expect(page.locator(".status-activity-label")).toHaveText("Working");
  await detailsButton(page).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("First text 0.10s");
  await expect(dialog).toContainText("Text 27 chars");
  await expect(dialog).toContainText("Tokens 90 in / 10 out · reasoning 0");
  await expect(dialog).toContainText("Conversation 450,000 tokens");
  await expect(dialog).not.toContainText("Current turn 100 tokens");
  await expect(dialog).toContainText("Last decode 180.0 tok/s");
  await expect(dialog).toContainText("KV 8,783 tok · 256 hot pages");
  await expect(dialog).toContainText("24.0 / 32.0 GiB (last request)");
  await expect(dialog.locator("[data-gpu-live]")).toContainText(
    "VRAM 29.4/31.8 GiB",
  );
  await expect(dialog).toContainText("App RAM 263 MB");
  await page.evaluate(() => (window as any).patchEngine({ status: "waiting" }));
  await expect(dialog.locator("[data-turn-detail]")).toContainText(
    "Awaiting approval",
  );
  await expect(dialog.locator("[data-axiom-activity]")).toHaveText(
    "Axiom awaiting approval",
  );
  await page.keyboard.press("Escape");
  for (const [status, label] of [
    ["failed", "Failed"],
    ["interrupted", "Interrupted"],
    ["idle", "Ready"],
  ]) {
    await page.evaluate(
      (status) => (window as any).patchEngine({ status }),
      status,
    );
    await expect(page.locator(".status-activity-label")).toHaveText(label);
  }
});

test("Active agents stay inspectable when the main pane narrows beside a sidebar", async ({ page }) => {
  await mount(page);
  await page.evaluate(() => (window as any).patchEngine({ agents: [
    { id: "active", name: "Active agent", parentId: "root", task: "Controlled test", status: "running", result: "", simulated: true },
    { id: "done", name: "Completed agent", parentId: "root", task: "Controlled test", status: "completed", result: "done", simulated: true },
  ] }));
  await expect(page.locator(".status-agents")).toHaveText("Agents 1 active");
  await page.evaluate(() => { document.querySelector<HTMLElement>("main")!.style.width = "550px"; });
  await expect(page.locator(".status-agents")).toBeHidden();
  expect(await page.locator("footer").evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  await detailsButton(page).click();
  await expect(page.getByRole("dialog")).toContainText("Agents 1 active");
});

test("Dialog is modal, restores focus and clears the native-browser overlay on close/provider switch/unmount", async ({
  page,
}) => {
  await mount(page);
  await detailsButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(page.locator("[data-native-browser-hidden]")).toHaveAttribute(
    "data-native-browser-hidden",
    "true",
  );
  await expect(
    page.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(
    page.getByRole("dialog").locator(".app-server-status"),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("button", { name: "Close", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(detailsButton(page)).toBeFocused();
  await expect(page.locator("[data-native-browser-hidden]")).toHaveAttribute(
    "data-native-browser-hidden",
    "false",
  );
  await detailsButton(page).click();
  await page.evaluate(() => (window as any).setMode("external"));
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator(".status-gpu")).toHaveCount(0);
  await expect(page.locator("[data-native-browser-hidden]")).toHaveAttribute(
    "data-native-browser-hidden",
    "false",
  );
  const calls = await page.evaluate(() => (window as any).calls);
  await tick(page, 6000);
  expect(await page.evaluate(() => (window as any).calls)).toBe(calls);
  await detailsButton(page).click();
  await expect(page.getByRole("dialog").locator("section")).toHaveCount(2);
  await page.evaluate(() => (window as any).setMounted(false));
  await expect(page.locator("[data-native-browser-hidden]")).toHaveAttribute(
    "data-native-browser-hidden",
    "false",
  );
});

test("Dynamic GPU inventory preserves measured zero, unknown, multiple devices and stale/error states", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    (window as any).devices[0].utilizationPercent = 0;
  });
  await tick(page);
  await expect(page.locator(".status-gpu")).toContainText("GPU 0%");
  await page.evaluate(() => {
    const w = window as any;
    w.devices = [
      {
        ...w.devices[0],
        id: "replacement",
        name: "Replacement GPU",
        utilizationPercent: null,
      },
    ];
  });
  await tick(page);
  await expect(page.locator("[data-gpu-live='gpu-first']")).toHaveCount(0);
  await expect(page.locator(".status-gpu")).toContainText("GPU —");
  await page.evaluate(() => {
    const w = window as any;
    w.devices.push({
      ...w.devices[0],
      id: "second",
      name: "Second GPU",
      utilizationPercent: 80,
    });
  });
  await tick(page);
  await expect(page.locator(".status-gpu")).toHaveText("2 GPUs");
  await detailsButton(page).click();
  await expect(page.getByRole("dialog").locator("[data-gpu-live]")).toHaveCount(
    2,
  );
  await expect(page.locator("[data-gpu-live='replacement']")).toContainText(
    "Replacement GPU · —",
  );
  await expect(page.locator("[data-gpu-live='second']")).toContainText("80%");
  await page.evaluate(() => {
    (window as any).age = 10000;
  });
  await tick(page);
  await expect(page.locator("[data-gpu-live]")).toHaveCount(0);
  await expect(page.getByRole("dialog")).toContainText("(stale)");
  await page.evaluate(() => {
    (window as any).age = 0;
    (window as any).fail = true;
  });
  await tick(page);
  await expect(page.locator("[data-gpu-live]")).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).fail = false;
    (window as any).devices = [];
  });
  await tick(page);
  await expect(page.locator(".status-gpu")).toHaveText("No GPU detected");
});

test("Polling stays single while details open, pauses when hidden and never overlaps requests", async ({
  page,
}) => {
  await mount(page);
  expect(await page.evaluate(() => (window as any).calls)).toBe(1);
  await detailsButton(page).click();
  await tick(page);
  expect(await page.evaluate(() => (window as any).calls)).toBe(2);
  await page.evaluate(() =>
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "hidden",
    }),
  );
  await tick(page, 10000);
  expect(await page.evaluate(() => (window as any).calls)).toBe(2);
  await expect(page.locator("[data-gpu-live]")).toHaveCount(0);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      value: "visible",
    });
    (window as any).hold = true;
  });
  await tick(page, 6000);
  expect(await page.evaluate(() => (window as any).calls)).toBe(3);
  await page.evaluate(() => {
    (window as any).hold = false;
    (window as any).release();
  });
  await tick(page);
  expect(await page.evaluate(() => (window as any).calls)).toBe(4);
});

test("Global connection and simulation remain explicit independently of chat status", async ({
  page,
}) => {
  await mount(page, 390);
  for (const [phase, label] of [
    ["starting", "Connecting…"],
    ["reconnecting", "Reconnecting…"],
    ["offline", "Offline"],
  ]) {
    await page.evaluate((phase) => (window as any).setPhase(phase), phase);
    await expect(page.locator(".status-connection")).toContainText(label);
    await expect(page.locator(".status-activity-label")).toHaveText(
      "Completed",
    );
  }
  await page.evaluate(() => {
    (window as any).setMode("simulation");
    (window as any).setMetrics(null);
  });
  await expect(page.locator(".status-provider")).toHaveText("simulation");
  await expect(page.locator(".app-server-status")).toHaveCount(0);
  await detailsButton(page).click();
  await expect(page.getByRole("dialog")).toContainText("App RAM —");
  await expect(page.getByRole("dialog")).toContainText("PTY —");
});

for (const width of [2048, 900, 390])
  test(`150% zoom and small vertical space: ${width}px`, async ({ page }) => {
    await mount(page, width, "de", "light", 1.5);
    await page.setViewportSize({ width, height: 600 });
    await page.evaluate(() =>
      (window as any).patchEngine({ status: "waiting" }),
    );
    expect(
      await page
        .locator("footer")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await detailsButton(page).click();
    const dialog = page.getByRole("dialog"),
      box = (await dialog.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
    expect(
      await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth),
    ).toBe(true);
    await page
      .getByRole("dialog")
      .locator("section")
      .last()
      .scrollIntoViewIfNeeded();
    await expect(page.getByRole("dialog").getByText("PTY 2")).toBeInViewport();
    await expect(page.getByRole("dialog").getByRole("button")).toBeInViewport();
  });
