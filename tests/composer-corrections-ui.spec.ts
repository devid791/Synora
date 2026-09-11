// Real App/CSS and browser clipboard events, controlled named service boundary.
// Never invokes a provider or executes a model/tool request.
import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";
import type {} from "./fixtures/engine-pending-ui";
let script: string, css: string, logo: string;
const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="80" height="60" fill="#2563eb"/></svg>').render().asPng().toString("base64");
test.beforeAll(async () => {
  script = (await build({ entryPoints: ["tests/fixtures/engine-pending-ui.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  css = (await readFile("src/renderer/style.css", "utf8")).replace(/^@import.*$/gm, "");
  logo = await readFile("public/brand/synora.svg", "utf8");
});
test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost:43197" });
  await page.route("**/*", route => route.request().url().endsWith(".svg")
    ? route.fulfill({ contentType: "image/svg+xml", body: logo })
    : route.fulfill({ contentType: "text/html", body: '<div id="root"></div>' }));
  await page.goto("http://localhost:43197");
  await page.addStyleTag({ content: css });
  await page.evaluate(() => { window.enginePendingOptions = { preferences: { theme: "dark", sidebarCollapsed: false, filesCollapsed: true } }; });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Retained draft");
});
const input = (p: Page) => p.getByRole("textbox", { name: "Message", exact: true });
const calls = (p: Page, method: string) => p.evaluate(method => window.enginePending.calls.filter(c => c.method === method), method);
test("Cold renderer restores the last selected older conversation; deleted/archived selections fall back safely", async ({ page }) => {
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(input(page)).toHaveValue("");
  await page.getByRole("button", { name: "Open conversation: Offline pending regression", exact: true }).click();
  await expect(input(page)).toHaveValue("Retained draft");
  const saved = await page.evaluate(() => structuredClone(window.enginePending.state));
  expect(saved.preferences.selectedConversationId).toBe("offline-conversation");
  for (const variant of ["older", "missing", "archived"] as const) {
    const seed = structuredClone(saved);
    if (variant === "missing") seed.preferences.selectedConversationId = "deleted-qa-record";
    if (variant === "archived") seed.conversations.find(c => c.id === "offline-conversation")!.archived = true;
    await page.reload();
    await page.addStyleTag({ content: css });
    await page.evaluate(json => {
      const state = JSON.parse(json) as typeof window.enginePending.state;
      window.enginePendingOptions = { preferences: state.preferences, seed: { conversations: state.conversations } };
    }, JSON.stringify(seed));
    await page.addScriptTag({ content: script });
    await expect(input(page)).toHaveValue(variant === "older" ? "Retained draft" : "");
    expect(await page.evaluate(() => window.enginePending.state.conversations)).toEqual(seed.conversations);
    expect(await calls(page, "engineStart")).toEqual([]);
  }
});
test("Global New conversation opens the composer from another view and preserves the previous draft", async ({ page }) => {
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.locator(".workspace")).toHaveCount(0);
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(input(page)).toBeVisible();
  await expect(input(page)).toHaveValue("");
  await expect(input(page)).toBeFocused();
  expect(await calls(page, "newConversation")).toHaveLength(1);
  expect(await page.evaluate(() => window.enginePending.state.conversations.find(c => c.id === "offline-conversation")?.draft)).toBe("Retained draft");
  expect(await calls(page, "engineStart")).toEqual([]);
});
test("New conversation focuses the committed composer even if an early animation frame precedes the Browser route commit", async ({ page }) => {
  await page.getByRole("button", { name: "Browser", exact: true }).click();
  await expect(input(page)).toHaveCount(0);
  await page.evaluate(() => {
    // Exercise the ordering observed on native macOS: a one-shot frame is not
    // a guarantee that React has committed the newly selected route's textarea.
    const original = window.requestAnimationFrame;
    window.requestAnimationFrame = callback => {
      window.requestAnimationFrame = original;
      callback(performance.now());
      return 0;
    };
  });
  await page.getByRole("button", { name: "New conversation", exact: true }).click();
  await expect(input(page)).toBeVisible();
  await expect(input(page)).toBeFocused();
  await page.keyboard.type("Ready to type without another click");
  await expect(input(page)).toHaveValue("Ready to type without another click");
  expect(await calls(page, "newConversation")).toHaveLength(1);
  expect(await page.evaluate(() => window.enginePending.state.conversations.find(c => c.id === "offline-conversation")?.draft)).toBe("Retained draft");
  expect(await calls(page, "engineStart")).toEqual([]);
});
test("A registered workspace stays visible when a bound conversation cannot move; its history and draft stay intact", async ({ page }) => {
  await page.evaluate(() => {
    const c = window.enginePending.state.conversations[0];
    c.binding = structuredClone(window.enginePending.state.conversations[1].binding);
  });
  const before = await page.evaluate(() => structuredClone(window.enginePending.state.conversations));
  await page.getByRole("button", { name: "Show files panel", exact: true }).click();
  await page.getByRole("button", { name: "Add workspace", exact: true }).click();
  await page.getByLabel("Service folder", { exact: true }).fill("/new-qa");
  await page.getByRole("button", { name: "Open folder", exact: true }).click();
  await expect(page.locator(".form-error")).toContainText("A live conversation cannot change workspace");
  await page.keyboard.press("Escape");
  await expect(page.getByLabel("Active workspace").locator('option[value="new-workspace"]')).toHaveText("New QA workspace");
  await expect(page.getByLabel("Active workspace")).toHaveValue("");
  await expect(input(page)).toHaveValue("Retained draft");
  expect(await page.evaluate(() => window.enginePending.state.conversations)).toEqual(before);
  expect(await calls(page, "newConversation")).toEqual([]);
});
test("900x640 welcome with both panels and an actionable notice keeps logo/title/all eight starters visible and hittable", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 640 });
  await page.getByRole("button", { name: "Show files panel", exact: true }).click();
  await page.evaluate(() => window.enginePending.event({ kind: "notice", message: "File saved" }));
  await expect(page.locator(".notice").filter({ hasText: "File saved" })).toBeVisible();
  await expect(page.locator(".starter-grid > button")).toHaveCount(8);
  const boxes = await page.locator(".welcome").evaluate(welcome => {
    const clip = welcome.closest(".chat-scroll")!.getBoundingClientRect();
    return [...welcome.querySelectorAll(".welcome-heading img, h1, .starter-grid > button")].map(el => {
      const r = el.getBoundingClientRect();
      return { text: el.textContent, visible: r.top >= clip.top - 1 && r.bottom <= clip.bottom + 1,
        hittable: el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)) };
    });
  });
  expect(boxes.every(b => b.visible && b.hittable), JSON.stringify(boxes)).toBe(true);
  expect(await page.locator(".chat-scroll").evaluate(e => e.scrollHeight <= e.clientHeight + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath("welcome-short-notice.png") });
  await page.locator(".starter-grid > button").last().click();
  await expect(input(page)).not.toHaveValue("Retained draft");
});
for (const locale of ["en", "it", "fr", "de", "es", "pt", "nl"] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`Short welcome fits translated labels without scrolling: ${locale}/${theme}`, async ({ page }, info) => {
      await page.reload();
      await page.addStyleTag({ content: css });
      await page.evaluate(({ locale, theme }) => {
        window.enginePendingOptions = { axiom: true, connected: true, panels: true, preferences: {
          locale, theme, sidebarCollapsed: false, filesCollapsed: false, profile: "ultra-fast", context: 262144,
        } };
      }, { locale, theme });
      await page.addScriptTag({ content: script });
      await expect(page.locator(".composer textarea")).toHaveValue("Retained draft");
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      await page.evaluate(() => window.enginePending.event({ kind: "notice", message: "File saved." }));
      // macOS's 900x640 outer window leaves 900x608 renderer pixels after its title bar.
      // Also cover the full 640px browser viewport: these are controlled UI tests, not native QA.
      for (const height of [608, 640]) {
        await page.setViewportSize({ width: 900, height });
        await expect(page.locator(".starter-grid > button")).toHaveCount(8);
        const geometry = await page.locator(".chat-scroll").evaluate(clip => {
          const bounds = clip.getBoundingClientRect();
          const elements = [...clip.querySelectorAll(".welcome-heading img, h1, .starter-grid > button")].map(el => {
            const b = el.getBoundingClientRect();
            return { text: el.textContent, inside: b.top >= bounds.top - 1 && b.bottom <= bounds.bottom + 1,
              hittable: el.contains(document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2)) };
          });
          return { height: clip.clientHeight, scrollHeight: clip.scrollHeight,
            width: clip.clientWidth, scrollWidth: clip.scrollWidth, elements };
        });
        await page.screenshot({ path: info.outputPath(`welcome-${locale}-${theme}-${height}.png`) });
        expect(geometry.elements.every(e => e.inside && e.hittable), JSON.stringify(geometry)).toBe(true);
        expect(geometry.scrollHeight, JSON.stringify(geometry)).toBeLessThanOrEqual(geometry.height + 1);
        expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width + 1);
      }
      for (const button of await page.locator(".starter-grid > button").all()) {
        await page.locator(".composer textarea").fill("Retained draft");
        await button.click();
        await expect(page.locator(".composer textarea")).toHaveValue(/^Retained draft\n\n.+/s);
      }
      expect(await calls(page, "engineStart")).toEqual([]);
    });
  }
}
async function pasteFiles(page: Page, names: string[], options: { mime?: string; body?: string; text?: string; drop?: boolean } = {}) {
  await input(page).evaluate((node, { names, options, png }) => {
    const data = new DataTransfer();
    for (const name of names) data.items.add(new File([options.body ?? Uint8Array.from(atob(png), c => c.charCodeAt(0))], name, { type: options.mime ?? "image/png" }));
    if (options.text) data.setData("text/plain", options.text);
    node.dispatchEvent(options.drop ? new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }) :
      new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
  }, { names, options, png });
}
test("Native browser Ctrl+V pastes an image into the same draft, removable and never auto-sent", async ({ page }, info) => {
  await input(page).focus();
  await page.evaluate(async png => {
    const blob = new Blob([Uint8Array.from(atob(png), c => c.charCodeAt(0))], { type: "image/png" });
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }, png);
  await page.keyboard.press("Control+v");
  await expect(page.locator('.composer .image-attachment img')).toHaveCount(1);
  await expect(page.locator('.composer .image-attachment img')).toBeVisible();
  await expect(input(page)).toHaveValue("Retained draft");
  expect(await calls(page, "imageAttach")).toHaveLength(1);
  expect(await calls(page, "engineStart")).toEqual([]);
  expect(await page.evaluate(() => window.enginePending.state.conversations.length)).toBe(2);
  await page.screenshot({ path: info.outputPath("pasted-image.png") });
  await page.locator('.composer .image-attachment button').click();
  await expect(page.locator('.composer .image-attachment')).toHaveCount(0);
});
test("Plain/rich text paste keeps native caret, undo and markup as text", async ({ page }) => {
  await input(page).focus();
  await input(page).evaluate((e: HTMLTextAreaElement) => e.setSelectionRange(0, 8));
  await page.evaluate(() => navigator.clipboard.writeText("New"));
  await page.keyboard.press("Control+v");
  await expect(input(page)).toHaveValue("New draft");
  await page.keyboard.press("Control+z");
  await expect(input(page)).toHaveValue("Retained draft");
  await page.evaluate(() => navigator.clipboard.write([new ClipboardItem({
    "text/plain": new Blob(["RICH_TEXT"], { type: "text/plain" }),
    "text/html": new Blob(['<b>RICH_TEXT</b><img src="https://never-fetch.invalid/image">'], { type: "text/html" }),
  })]));
  await page.keyboard.press("Control+v");
  await expect(input(page)).toHaveValue("RICH_TEXT draft");
  expect(await calls(page, "imageAttach")).toEqual([]);
});
test("Multiple pasted images and text, drop and file picker use the same image path", async ({ page }) => {
  await input(page).evaluate((e: HTMLTextAreaElement) => e.setSelectionRange(0, 8));
  await pasteFiles(page, ["one.png", "two.png"], { text: "Mixed" });
  await expect(page.locator('.composer .image-attachment')).toHaveCount(2);
  await expect(input(page)).toHaveValue("Mixed draft");
  await pasteFiles(page, ["drop.png"], { drop: true });
  await expect(page.locator('.composer .image-attachment')).toHaveCount(3);
  await page.getByLabel("Attach image files").setInputFiles({ name: "picker.png", mimeType: "image/png", buffer: Buffer.from(png, "base64") });
  await expect(page.locator('.composer .image-attachment')).toHaveCount(4);
  expect((await calls(page, "imageAttach")).map(c => c.args[0])).toEqual(Array(4).fill("offline-conversation"));
  expect(await calls(page, "engineStart")).toEqual([]);
});
test("Unsupported/broken/oversized files give explicit errors and preserve the draft", async ({ page }) => {
  for (const [name, mime, body, error] of [
    ["file.pdf", "application/pdf", "%PDF", "Attach PNG"],
    ["fake.png", "image/png", "<html>not an image</html>", "Image cannot be decoded"],
    ["big.png", "image/png", "x".repeat(8 * 1024 * 1024 + 1), "Attach PNG"],
  ]) {
    await pasteFiles(page, [name], { mime, body });
    await expect(page.getByRole("alert").first()).toContainText(error);
    await expect(input(page)).toHaveValue("Retained draft");
    await page.getByRole("alert").first().getByRole("button").click();
  }
  expect(await calls(page, "imageAttach")).toEqual([]);
});
test("Pending upload blocks double paste, switching, sending and permission changes; failure unlocks", async ({ page }) => {
  await page.evaluate(() => { window.enginePending.holdNextImage = true; });
  await pasteFiles(page, ["held.png"]);
  await expect.poll(() => calls(page, "imageAttach")).toHaveLength(1);
  await pasteFiles(page, ["duplicate.png"]);
  await expect(page.locator('.permission-trigger')).toBeDisabled();
  await input(page).press("Enter");
  await page.getByRole("button", { name: "Open conversation: Offline restore history", exact: true }).click();
  expect(await calls(page, "engineStart")).toEqual([]);
  expect(await calls(page, "imageAttach")).toHaveLength(1);
  await expect(input(page)).toHaveValue("Retained draft");
  await page.evaluate(() => window.enginePending.settle("imageAttach", "Controlled upload failure"));
  await expect(page.locator('.permission-trigger')).toBeEnabled();
  await pasteFiles(page, ["retry.png"]);
  await expect(page.locator('.composer .image-attachment')).toHaveCount(1);
});
test("Ask/full/auto/ask stays in one selected chat with history, draft and images intact", async ({ page }) => {
  await pasteFiles(page, ["keep.png"]);
  await expect(page.locator('.composer .image-attachment')).toHaveCount(1);
  const before = await page.evaluate(() => structuredClone(window.enginePending.state));
  const trigger = page.locator('.permission-trigger');
  for (const mode of ["full", "auto-review", "ask"] as const) {
    await trigger.click(); await page.locator(`[data-permission-option="${mode}"]`).click();
    if (mode === "full") await page.getByRole("button", { name: "Enable full access", exact: true }).click();
    await expect(trigger).toHaveAttribute("data-permission", mode);
    const after = await page.evaluate(() => window.enginePending.state);
    expect(after.conversations.length).toBe(2);
    expect({ ...after.conversations[0], defaults: before.conversations[0].defaults }).toEqual(before.conversations[0]);
    expect(after.conversations[1]).toEqual(before.conversations[1]);
    await expect(input(page)).toHaveValue("Retained draft");
  }
  expect(await calls(page, "newConversation")).toEqual([]);
  expect(await calls(page, "engineStart")).toEqual([]);
});
test("Permission cancel, pending and failure never change chat or discard draft", async ({ page }) => {
  const trigger = page.locator('.permission-trigger');
  await trigger.click(); await page.locator('[data-permission-option="full"]').click(); await page.keyboard.press("Escape");
  expect(await calls(page, "conversationPermission")).toEqual([]);
  await page.evaluate(() => { window.enginePending.holdNextPermission = true; });
  await trigger.click(); await page.locator('[data-permission-option="auto-review"]').click();
  await expect(trigger).toBeDisabled(); await expect(trigger).toHaveAttribute("data-permission", "ask");
  await page.evaluate(() => window.enginePending.settle("conversationPermission", "Controlled permission failure"));
  await expect(trigger).toBeEnabled(); await expect(trigger).toHaveAttribute("data-permission", "ask");
  await expect(input(page)).toHaveValue("Retained draft");
  expect(await calls(page, "newConversation")).toEqual([]);
});
