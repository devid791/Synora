import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let script: string, css: string;
test.beforeAll(async () => {
  script = (await build({ entryPoints: ["tests/fixtures/conversation-sidebar-ui.tsx"], bundle: true, write: false,
    platform: "browser", format: "iife", define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  css = (await readFile("src/renderer/style.css", "utf8")).replace(/^@import.*$/gm, "");
});
async function setup(page: Page, flags: Record<string, boolean> = {}) {
  await page.setViewportSize({ width: 1100, height: 820 });
  await page.setContent('<div id="root"></div>');
  await page.evaluate(flags => Object.assign(window, flags), flags);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: script });
}
async function actions(page: Page, title = "Alpha") { await page.getByRole("button", { name: `Conversation actions: ${title}`, exact: true }).click(); }
test("Chat menu targets the clicked chat, saves rename, pin/unread/archive and recovers from archive", async ({ page }) => {
  const errors: string[] = []; page.on("pageerror", e => errors.push(e.message));
  await setup(page);
  await page.getByRole("button", { name: "Open conversation: Zeta", exact: true }).click({ button: "right" });
  const iconPositions = await page.getByRole("menu").locator("button > svg:first-child").evaluateAll(icons => icons.map(icon => icon.getBoundingClientRect().x));
  expect(Math.max(...iconPositions) - Math.min(...iconPositions)).toBeLessThan(1);
  await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Renamed chat");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open conversation: Renamed chat", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open conversation: Alpha", exact: true })).toHaveAttribute("aria-current", "page");
  await actions(page, "Renamed chat"); await page.getByRole("menuitem", { name: "Pin", exact: true }).click();
  await expect(page.locator(".conversation-row").first()).toContainText("Renamed chat");
  await actions(page, "Renamed chat"); await page.getByRole("menuitem", { name: "Mark as unread", exact: true }).click();
  await expect(page.getByLabel("Unread", { exact: true })).toHaveCount(1);
  await page.getByRole("button", { name: "Open conversation: Renamed chat", exact: true }).click();
  await expect(page.getByLabel("Unread", { exact: true })).toHaveCount(0);
  await actions(page, "Renamed chat"); await page.getByRole("menuitem", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open conversation: Renamed chat", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sidebar options", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Show archived", exact: true }).click();
  await actions(page, "Renamed chat"); await page.getByRole("menuitem", { name: "Unarchive", exact: true }).click();
  await page.getByRole("button", { name: "Back to recent conversations", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open conversation: Renamed chat", exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).snapshot().conversations.find((c: any) => c.id === "c1").draft)).toBe("Original unsent text");
  expect(errors).toEqual([]);
});
test("Copy submenu exports exactly the chosen saved text/ID; clipboard errors never claim success", async ({ page }) => {
  await setup(page);
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { (window as any).copied = text; } } }));
  for (const [name, expected] of [["Copy title", "Alpha"], ["Copy conversation ID", "c0"], ["Copy conversation text", "User:\nSaved message 0"]]) {
    await actions(page); await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Copied");
    expect(await page.evaluate(() => (window as any).copied)).toBe(expected);
  }
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw Error("permission denied"); } } }));
  await actions(page); await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await page.getByRole("menuitem", { name: "Copy title", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing was copied");
  await expect(page.getByRole("status")).toHaveCount(0);
});
test("Native clipboard callback works with Chromium access denied and never reports failed writes as copied", async ({ page }) => {
  await setup(page, { nativeClipboard: true });
  await page.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async () => { throw Error("Chromium denied"); } } }));
  for (const [name, expected] of [["Copy title", "Alpha"], ["Copy conversation ID", "c0"], ["Copy conversation text", "User:\nSaved message 0"]]) {
    await actions(page); await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("Copied");
    expect(await page.evaluate(() => (window as any).nativeCopied)).toBe(expected);
  }
  await page.evaluate(() => { (window as any).failNativeClipboard = true; });
  await actions(page); await page.getByRole("menuitem", { name: "Copy", exact: true }).click();
  await page.getByRole("menuitem", { name: "Copy title", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Nothing was copied");
  await expect(page.getByRole("status")).toHaveCount(0);
});
test("Sidebar nested grouping/sorting menus are keyboard accessible; project move leaves execution folder unchanged", async ({ page }) => {
  await setup(page);
  await page.getByRole("button", { name: "Sidebar options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Organize sidebar", exact: true }).focus(); await page.keyboard.press("ArrowRight");
  await page.getByRole("menuitemradio", { name: "By project", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Project One", exact: true })).toBeVisible();
  await actions(page); await page.getByRole("menuitem", { name: "Project", exact: true }).click();
  await expect(page.getByRole("menu")).toContainText("execution folder stays unchanged");
  await page.getByRole("menuitemradio", { name: "Project Two", exact: true }).click();
  expect(await page.evaluate(() => { const c = (window as any).snapshot().conversations[0]; return [c.workspaceId, c.projectId]; })).toEqual(["w1", "w2"]);
  await expect(page.getByRole("heading", { name: "Project One", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Sidebar options", exact: true }).click();
  await page.getByRole("menuitem", { name: "Sort chats by", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "Title", exact: true }).click();
  expect(await page.evaluate(() => (window as any).snapshot().preferences.conversationSort)).toBe("title");
  await actions(page); await page.keyboard.press("End"); await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Conversation actions: Alpha", exact: true })).toBeFocused();
  await expect(page.getByRole("menu")).toHaveCount(0);
});
test("More than 30 chats remain reachable, popup contains at bottom and busy history cannot be archived/forked", async ({ page }) => {
  await setup(page, { largeHistory: true, engineBusy: true });
  await expect(page.locator(".conversation-row")).toHaveCount(50);
  await page.getByRole("button", { name: "Show more conversations", exact: true }).click();
  await expect(page.locator(".conversation-row")).toHaveCount(72);
  await actions(page, "Chat 71");
  expect(await page.getByRole("menu").evaluate(e => { const r = e.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth; })).toBe(true);
  await page.keyboard.press("Escape"); await actions(page);
  await expect(page.getByRole("menuitem", { name: "Archive", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Delete conversation", exact: true })).toBeDisabled();
  await expect(page.getByRole("menuitem", { name: "Fork as new draft", exact: true })).toBeDisabled();
});
test("Deletion confirms the clicked title, supports cancel and removes only that conversation", async ({ page }) => {
  await setup(page);
  await actions(page, "Zeta"); await page.getByRole("menuitem", { name: "Delete conversation", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete conversation", exact: true });
  await expect(dialog).toContainText("Zeta"); await expect(dialog).toContainText("cannot be undone");
  await expect(dialog).toContainText("Project files");
  await expect(dialog.getByRole("button", { name: "Delete permanently", exact: true })).not.toBeFocused();
  await page.keyboard.press("Escape");
  expect(await page.evaluate(() => (window as any).calls)).toEqual([]);
  await actions(page, "Zeta"); await page.getByRole("menuitem", { name: "Delete conversation", exact: true }).click();
  await dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open conversation: Zeta", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Open conversation: Alpha", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("status")).toHaveText("Conversation deleted");
  expect(await page.evaluate(() => (window as any).calls)).toEqual([{ delete: "c1" }]);
});
test("Deletion failure keeps the conversation and confirmation open", async ({ page }) => {
  await setup(page, { failDelete: true }); await actions(page);
  await page.getByRole("menuitem", { name: "Delete conversation", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Delete conversation", exact: true });
  await dialog.getByRole("button", { name: "Delete permanently", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Controlled delete failure");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open conversation: Alpha", exact: true })).toBeVisible();
});
test("Save failure is visible and preserves name; plain-text fork requires confirmation and never submits a turn", async ({ page }) => {
  await setup(page, { failUpdate: true });
  await actions(page); await page.getByRole("menuitem", { name: "Rename", exact: true }).click();
  await page.getByRole("textbox", { name: "Title", exact: true }).fill("Not saved");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog").getByRole("alert")).toContainText("Controlled save failure");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("button", { name: "Open conversation: Alpha", exact: true })).toBeVisible();
  await actions(page); await page.getByRole("menuitem", { name: "Fork as new draft", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("tool state is not cloned");
  await page.getByRole("button", { name: "Create draft", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Draft", exact: true })).toContainText("Saved message 0");
  expect(await page.evaluate(() => (window as any).calls.some((c: any) => c === "engineStart"))).toBe(false);
});
test("Eight starters append editable text, preserve the draft, and invoke no engine or tool", async ({ page }) => {
  await setup(page);
  const starters = page.getByRole("region", { name: "Ideas to get started", exact: true });
  await expect(starters.getByRole("button")).toHaveCount(8);
  const rectangles = await starters.getByRole("button").evaluateAll(buttons => buttons.map(b => ({ x: b.getBoundingClientRect().x, y: b.getBoundingClientRect().y, width: b.getBoundingClientRect().width })));
  expect(new Set(rectangles.map(r => r.y)).size).toBe(4);
  expect(Math.min(...rectangles.map(r => r.width))).toBeGreaterThan(200);
  await starters.getByRole("button", { name: "Find a bug", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Draft", exact: true })).toHaveValue(/^Original unsent text\n\nHelp me diagnose/);
  await starters.getByRole("button", { name: "Write tests", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Draft", exact: true })).toHaveValue(/including edge cases/);
  expect(await page.evaluate(() => (window as any).calls)).toEqual([]);
  await page.screenshot({ path: "test-results/conversations-starters.png" });
});
