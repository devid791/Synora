// Actual App renderer, controlled typed API. No Core/model requests.
import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type {} from "./fixtures/engine-pending-ui";
let script: string;
test.beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["tests/fixtures/engine-pending-ui.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});
async function mount(page: Page, width = 1280, preferences = {}) {
  await page.setViewportSize({ width, height: 900 });
  await page.route("**/*", (r) => r.abort());
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({
    content: (await readFile("src/renderer/style.css", "utf8")).replace(
      /^@import.*$/gm,
      "",
    ),
  });
  await page.evaluate((preferences) => {
    window.enginePendingOptions = { panels: true, preferences };
  }, preferences);
  await page.addScriptTag({ content: script });
  await expect(page.getByTestId("toggle-sidebar")).toBeVisible();
}
async function intact(page: Page) {
  const s = await page.evaluate(() => window.enginePending);
  expect(s.state.conversations[0].id).toBe("offline-conversation");
  expect(s.state.conversations[0].draft).toBe("Retained draft");
  expect(s.calls.filter((c) => /^engine/.test(c.method))).toEqual([]);
  expect(s.unexpected).toEqual([]);
}
for (const width of [390, 1000, 1440])
  test(`Independent collapse/reopen and space recovery at ${width}px`, async ({
    page,
  }, info) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await mount(page, width);
    const side = page.getByTestId("toggle-sidebar"),
      files = page.getByTestId("toggle-files");
    const before = await page.locator(".conversation").boundingBox();
    await side.click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect(side).toHaveAttribute("aria-expanded", "false");
    await expect(side).toBeFocused();
    await expect(page.locator(".files")).toBeVisible();
    await files.focus();
    await page.keyboard.press("Enter");
    await expect(page.locator(".files")).toBeHidden();
    await expect(files).toBeFocused();
    const after = await page.locator(".conversation").boundingBox();
    if (width > 700) expect(after!.width - before!.width).toBeGreaterThan(300);
    else expect(after!.y).toBeLessThan(before!.y);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Retained draft");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({ path: info.outputPath("both-collapsed.png") });
    // Both reopening controls stay visible, even after navigating to Settings.
    await page
      .getByRole("button", { name: "Open settings", exact: true })
      .click();
    await expect(side).toBeVisible();
    await expect(files).toHaveCount(0);
    await side.click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.locator(".files")).toBeHidden();
    await files.click();
    await expect(page.locator(".files")).toBeVisible();
    await expect(page.getByLabel("Active workspace")).toHaveValue(
      "panel-workspace",
    );
    await intact(page);
    expect(errors).toEqual([]);
  });
test("Unsaved editor and directory stay intact while both panels hide", async ({
  page,
}) => {
  await mount(page);
  await page.locator(".file-list button").click();
  const editor = page.locator("textarea.editor");
  await editor.fill("UNSAVED_EDITOR");
  for (const id of [
    "toggle-files",
    "toggle-sidebar",
    "toggle-files",
    "toggle-sidebar",
  ])
    await page.getByTestId(id).click();
  await expect(editor).toHaveValue("UNSAVED_EDITOR");
  await expect(page.getByLabel("Active workspace")).toHaveValue(
    "panel-workspace",
  );
  expect(
    (await page.evaluate(() => window.enginePending.calls)).filter(
      (c) => c.method === "listFiles",
    ),
  ).toHaveLength(1);
  await intact(page);
});
test("Failed save preserves layout; pending controls do not duplicate writes", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    window.enginePending.holdNextPreferences = true;
  });
  const side = page.getByTestId("toggle-sidebar"),
    files = page.getByTestId("toggle-files");
  await side.click();
  await expect(side).toHaveAttribute("aria-disabled", "true");
  // aria-disabled keeps keyboard focus; exercise the actual guarded handler.
  await page.keyboard.press("Enter");
  await files.focus();
  await page.keyboard.press("Enter");
  expect(
    (await page.evaluate(() => window.enginePending.calls)).filter(
      (c) => c.method === "preferences",
    ),
  ).toHaveLength(1);
  await page.evaluate(() =>
    window.enginePending.settle("preferences", "CONTROLLED storage failure"),
  );
  await expect(page.getByRole("alert")).toContainText(
    "CONTROLLED storage failure",
  );
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".files")).toBeVisible();
  await side.click();
  await expect(page.locator(".sidebar")).toBeHidden();
  await intact(page);
});
test("Restored collapsed preferences expose translated reopening controls", async ({
  page,
}) => {
  await mount(page, 1280, {
    sidebarCollapsed: true,
    filesCollapsed: true,
    compact: true,
    locale: "it",
  });
  await expect(page.locator(".sidebar")).toBeHidden();
  await expect(page.locator(".files")).toBeHidden();
  await page.getByRole("button", { name: "Mostra barra laterale" }).click();
  await page.getByRole("button", { name: "Mostra pannello file" }).click();
  await expect(page.locator(".sidebar")).toBeVisible();
  await expect(page.locator(".files")).toBeVisible();
  await intact(page);
});
