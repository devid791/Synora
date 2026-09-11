import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import seed from "../src/shared/plugin-directory-seed.json" with { type: "json" };
let script: string;
test.beforeAll(async () => {
  script = (await build({ entryPoints: ["tests/fixtures/plugin-directory-ui.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
});
for (const width of [1440, 390]) test(`Plugin directory always visible with no workspace, no account and a busy Axiom at ${width}px`, async ({ page }) => {
  const errors: string[] = [], requests: string[] = [];
  page.on("pageerror", e => errors.push(e.message));
  await page.setViewportSize({ width, height: 1000 });
  await page.route("**/*", r => { requests.push(r.request().url()); return r.abort(); });
  await page.setContent('<div style="padding:16px" id="root"></div>');
  await page.evaluate(() => { (window as any).engineBusy = true; });
  await page.addStyleTag({ content: (await readFile("src/renderer/style.css", "utf8")).replace(/^@import.*$/gm, "") });
  await page.addScriptTag({ content: script });
  const cards = page.locator(".plugin-directory-card");
  expect(await cards.count()).toBeGreaterThanOrEqual(60);
  await page.getByRole("textbox", { name: "Search plugins" }).fill("Gmail");
  await expect(page.getByRole("heading", { name: "Gmail", exact: true })).toBeVisible();
  const icon = page.getByRole("img", { name: "Gmail original icon", exact: true });
  await expect(icon).toBeVisible();
  await expect.poll(() => icon.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  await page.getByRole("button", { name: "View plugin" }).click();
  await expect(page.getByRole("dialog", { name: "Gmail" })).toContainText("Nothing is installed");
  expect(await page.evaluate(() => (window as any).directoryCalls.map((c: any) => c.method))).toEqual(["pluginDirectoryRead"]);
  await page.getByRole("button", { name: "Close plugin", exact: true }).click();
  await page.getByRole("button", { name: "Refresh directory", exact: true }).click();
  expect(await page.evaluate(() => (window as any).directoryCalls)).toEqual([
    { method: "pluginDirectoryRead", args: [false] }, { method: "pluginDirectoryRead", args: [true] },
  ]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]); expect(requests).toEqual([]);
  await page.screenshot({ path: `test-results/plugin-directory-${width}.png`, fullPage: true });
});

test("Offline seed survives read/refresh failure without a provider; connection needs an explicit decision", async ({ page }) => {
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => { (window as any).noProviders = true; (window as any).directoryFailure = true; });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("alert")).toContainText("Controlled offline failure");
  await page.getByRole("textbox", { name: "Search plugins" }).fill("Gmail");
  await expect(page.getByRole("heading", { name: "Gmail", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh directory", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Gmail", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View plugin" }).click();
  await page.getByRole("button", { name: "Manage connection", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "Catalog workspace" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Read Core catalog" })).toBeDisabled();
  const calls = await page.evaluate(() => (window as any).directoryCalls);
  expect(calls.some((c: any) => /Login|Install|Change|engine|Authorize/.test(c.method))).toBe(false);
});

test("Directory auto-update preference persists through the real named API only", async ({ page }) => {
  await page.setContent('<div id="root"></div>');
  await page.addScriptTag({ content: script });
  const auto = page.getByRole("checkbox", { name: "Automatically update the directory" });
  await expect(auto).toBeChecked(); await auto.uncheck(); await expect(auto).not.toBeChecked();
  expect(await page.evaluate(() => (window as any).directoryCalls.filter((c: any) => c.method === "preferences"))).toEqual([
    { method: "preferences", args: [{ pluginCatalogAutomatic: false }] },
  ]);
});

for (const width of [1440, 390, 2160]) test(`All public cards stay compact; full long text opens on demand at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: 1000 });
  await page.setContent('<div style="padding:16px" id="root"></div>');
  await page.addStyleTag({ content: (await readFile("src/renderer/style.css", "utf8")).replace(/^@import.*$/gm, "") });
  if (width === 2160) await page.addStyleTag({ content: ":root { font-size: 19.5px; }" });
  await page.addScriptTag({ content: script });
  await expect(page.locator(".plugin-directory-card")).toHaveCount(65);
  const geometry = await page.locator(".plugin-directory-card").evaluateAll(cards => cards.map(card => {
    const description = card.querySelector(".plugin-directory-preview")!;
    return { height: card.getBoundingClientRect().height, lines: description.getBoundingClientRect().height / parseFloat(getComputedStyle(description).lineHeight) };
  }));
  expect(Math.max(...geometry.map(c => c.height))).toBeLessThan(width === 2160 ? 450 : 350);
  expect(Math.max(...geometry.map(c => c.lines))).toBeLessThanOrEqual(3.05);
  await page.getByRole("textbox", { name: "Search plugins" }).fill("Canva");
  const card = page.locator(".plugin-directory-card").filter({ has: page.getByRole("heading", { name: "Canva", exact: true }) });
  const before = await card.boundingBox();
  const button = card.getByRole("button", { name: "View plugin", exact: true });
  await button.focus(); await page.keyboard.press("Enter");
  const detail = page.getByRole("dialog", { name: "Canva", exact: true });
  await expect(detail).toBeVisible();
  expect(await detail.locator(".plugin-directory-description").textContent()).toBe(seed.entries.find(e => e.name === "canva")!.description);
  await detail.getByRole("button", { name: "Manage connection", exact: true }).scrollIntoViewIfNeeded();
  expect(await detail.locator(".modal").evaluate(e => e.scrollTop > 0)).toBe(true);
  expect(await detail.evaluate(e => { const r = e.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; })).toBe(true);
  await page.keyboard.press("Escape"); await expect(detail).toHaveCount(0); await expect(button).toBeFocused();
  expect((await card.boundingBox())!.height).toBe(before!.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.evaluate(() => (window as any).directoryCalls.every((c: any) => c.method === "pluginDirectoryRead"))).toBe(true);
  await page.screenshot({ path: `test-results/plugin-compact-${width}.png` });
});
