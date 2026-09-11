// Full App, controlled API, real CSS/brand. No service/model requests.
import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type {} from "./fixtures/engine-pending-ui";
let script: string, css: string, logo: string, lightLogo: string;
test.beforeAll(async () => {
  script = (await build({ entryPoints: ["tests/fixtures/engine-pending-ui.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  css = (await readFile("src/renderer/style.css", "utf8")).replace(/^@import.*$/gm, "");
  logo = await readFile("public/brand/synora.svg", "utf8");
  lightLogo = await readFile("public/brand/synora-light.svg", "utf8");
});
for (const size of [
  { width: 1440, height: 900, panels: false },
  { width: 1440, height: 720, panels: false },
  { width: 1024, height: 640, panels: true },
  { width: 900, height: 600, panels: false },
  // Effective CSS viewport of a1024x768 native window at150% zoom.
  { width: 683, height: 512, panels: false },
  { width: 390, height: 844, panels: false },
  { width: 390, height: 667, panels: false },
]) for (const theme of ["light", "dark"] as const) test(`Welcome fits ${size.width}x${size.height}, panels ${size.panels}, ${theme}`, async ({ page }, info) => {
  await page.setViewportSize(size);
  await page.route("**/*", route => route.request().url().endsWith(".svg")
    ? route.fulfill({ contentType: "image/svg+xml", body: route.request().url().endsWith("synora-light.svg") ? lightLogo : logo }) : route.abort());
  await page.setContent('<base href="https://welcome-fixture.invalid/"><div id="root"></div>');
  await page.addStyleTag({ content: css });
  await page.evaluate(({ panels, theme }) => { window.enginePendingOptions = { panels: true, preferences: { theme, sidebarCollapsed: !panels, filesCollapsed: !panels } }; }, { panels: size.panels, theme });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Retained draft");
  await expect.poll(() => page.locator(".welcome img").evaluate((e: HTMLImageElement) => e.complete && e.naturalWidth > 0)).toBe(true);
  const geometry = () => page.evaluate(() => {
    const viewport = { top: 0, left: 0, right: innerWidth, bottom: innerHeight };
    const chat = document.querySelector(".chat-scroll")!;
    const visible = (e: Element) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= viewport.top && r.bottom <= viewport.bottom + 1 && r.left >= 0 && r.right <= innerWidth + 1;
    };
    const chatRect = chat.getBoundingClientRect();
    const welcome = document.querySelector(".welcome")!;
    const clipped = [...welcome.querySelectorAll("img, h1, button")].filter(e => {
      if (e.closest("[hidden]")) return false;
      const r = e.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !visible(e) || r.top < chatRect.top - 1 || r.bottom > chatRect.bottom + 1 || e.scrollWidth > e.clientWidth + 1 || (e.tagName === "BUTTON" && !e.contains(top));
    }).map(e => e.textContent || e.tagName);
    const headerRect = document.querySelector(".welcome-heading")?.getBoundingClientRect();
    const logoRect = welcome.querySelector("img")!.getBoundingClientRect();
    const titleRect = welcome.querySelector("h1")!.getBoundingClientRect();
    const subtitleRect = welcome.querySelector(".welcome-heading p")!.getBoundingClientRect();
    const center = (r: DOMRect) => r.x + r.width / 2;
    if (logoRect.bottom > titleRect.top) clipped.push("logo must be above title");
    if (!headerRect || Math.abs(center(logoRect) - center(headerRect)) > 1 || Math.abs(center(titleRect) - center(headerRect)) > 1) clipped.push("logo/title not centered on heading axis");
    if (subtitleRect.height && (subtitleRect.top < titleRect.bottom || Math.abs(center(subtitleRect) - center(titleRect)) > 1)) clipped.push("subtitle must be below and centered");
    const gridRect = document.querySelector(".starter-grid")!.getBoundingClientRect();
    const noteRect = document.querySelector(".simulation-note")!.getBoundingClientRect();
    if (headerRect && headerRect.bottom > gridRect.top + 1) clipped.push("heading/grid overlap");
    if (gridRect.bottom > noteRect.top + 1) clipped.push("grid/note overlap");
    return { clipped, chatOverflow: chat.scrollHeight - chat.clientHeight,
      outerOverflow: document.querySelector(".content")!.scrollHeight - document.querySelector(".content")!.clientHeight,
      chatTop: chat.scrollTop, composer: visible(document.querySelector(".composer")!), tutor: visible(document.querySelector(".tutor-entry")!),
      pageOverflow: document.documentElement.scrollHeight > innerHeight || document.documentElement.scrollWidth > innerWidth };
  });
  await expect.poll(geometry).toEqual({ clipped: [], chatOverflow: 0, outerOverflow: 0, chatTop: 0, composer: true, tutor: true, pageOverflow: false });
  await expect(page.locator(".starter-grid button:visible")).toHaveCount(8);
  await page.locator(".starter-grid button:visible").last().click();
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue(/^Retained draft\n\n/);
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toBeFocused();
  expect(await page.evaluate(() => window.enginePending.calls.filter(c => /^engine/.test(c.method)))).toEqual([]);
  await expect.poll(geometry).toEqual({ clipped: [], chatOverflow: 0, outerOverflow: 0, chatTop: 0, composer: true, tutor: true, pageOverflow: false });
  await page.screenshot({ path: info.outputPath("welcome-fit.png") });
});
