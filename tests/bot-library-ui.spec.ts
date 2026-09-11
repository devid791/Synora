import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type {} from "./fixtures/bot-library-ui";
import { botTemplates, templatePreset } from "../src/shared/bot-library";
import { localeSchema } from "../src/shared/locale";
import type { Preset } from "../src/shared/contracts";
import { translate } from "../src/renderer/i18n";
import { messages, templateLabels } from "../src/renderer/locales/bots";

let script: string, css: string, brand: string, lightBrand: string;
test.beforeAll(async () => {
  script = (await build({ entryPoints: ["tests/fixtures/bot-library-ui.tsx"], bundle: true, write: false, platform: "browser", format: "iife", loader: { ".css": "empty" }, define: { "process.env.NODE_ENV": '"production"' } })).outputFiles[0].text;
  css = (await readFile("src/renderer/style.css", "utf8")).replace(/^@import.*$/gm, "");
  brand = await readFile("public/brand/synora.svg", "utf8");
  lightBrand = await readFile("public/brand/synora-light.svg", "utf8");
});
const errors = new WeakMap<Page, string[]>();
async function mount(page: Page, options: Window["botOptions"] = {}) {
  const failures: string[] = []; errors.set(page, failures);
  page.on("pageerror", (e) => failures.push(e.message));
  await page.route("**/*", (route) => route.abort());
  await page.route(/http:\/\/bot-fixture\.invalid\/brand\/synora(?:-light)?\.svg$/, (route) => route.fulfill({ contentType: "image/svg+xml", body: route.request().url().endsWith("synora-light.svg") ? lightBrand : brand }));
  await page.setContent('<base href="http://bot-fixture.invalid/"><div id="root"></div>');
  await page.addStyleTag({ content: css });
  await page.evaluate((options) => { window.botOptions = options; }, options);
  await page.addScriptTag({ content: script });
  await expect(page.locator(options.view === "workspace" ? ".composer" : ".bot-library")).toBeVisible();
}
test.afterEach(async ({ page }) => {
  expect(errors.get(page) ?? []).toEqual([]);
  expect(await page.evaluate(() => window.botHarness?.unexpected ?? [])).toEqual([]);
});
const builtin = (page: Page, id = "coding") => page.locator(`[data-bot-template="${id}"]`);
const saved = (page: Page, id = "owned-bot") => page.locator(`[data-bot-id="${id}"]`);
const calls = (page: Page, method: string) => page.evaluate((method) => window.botHarness.calls.filter((c) => c.method === method), method);
const ownedBot = (patch: Partial<Preset> = {}): Preset => ({ ...templatePreset("coding"), id: "owned-bot", name: "USER <Bot> {name}", description: "USER description kept exactly", instructions: "KEEP_USER_INSTRUCTIONS", profile: "high", context: 1048576, connectorIds: ["owned-connector"], ...patch });
async function unchangedSession(page: Page, draft = "KEEP_DRAFT") {
  const state = await page.evaluate(() => window.botHarness.state);
  expect(state.conversations.find((c) => c.id === "owned-session")?.defaults).toEqual({ permission: "ask", bot: null });
  expect(state.conversations.find((c) => c.id === "owned-session")?.draft).toBe(draft);
  expect(state.engine).toEqual({ mode: "live", providerId: "controlled-provider", model: "controlled-model" });
  expect(state.preferences.profile).toBe("medium");
  expect(state.preferences.context).toBe(262144);
  expect(state.preferences.permission).toBeUndefined();
  expect((await page.evaluate(() => window.botHarness.calls)).filter((c) => ["engineStart", "engineConfigure", "orchestrationSave", "engineCancel"].includes(c.method))).toEqual([]);
}
async function contained(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  expect(await page.locator(".bot-card").evaluateAll((cards) => cards.every((card) => {
    const rect = card.getBoundingClientRect();
    return card.scrollWidth <= card.clientWidth + 1 && [...card.querySelectorAll("button")].every((button) => { const b = button.getBoundingClientRect(); return b.left >= rect.left && b.right <= rect.right + 1; });
  }))).toBe(true);
}

test("Offline first launch shows all eight real templates, category icons, searchable/filterable cards", async ({ page }, info) => {
  await page.setViewportSize({ width: 900, height: 950 });
  await mount(page, { platform: "linux" });
  await expect(page.locator("[data-bot-template]")).toHaveCount(8);
  await expect(page.locator("[data-bot-template] .bot-card-heading > svg")).toHaveCount(8);
  await expect(page.locator(".bot-library")).toContainText("No saved bots yet");
  await expect(page.locator(".bot-library")).toContainText("No cached catalog");
  expect((await calls(page, "botCatalogRead")).map((c) => c.args)).toEqual([[false]]);
  expect(await calls(page, "presetInstallTemplate")).toEqual([]);
  await contained(page); await page.screenshot({ path: info.outputPath("offline-library-900.png") });
  await page.getByLabel("Source", { exact: true }).selectOption("built-in");
  await expect(page.locator("[data-bot-template]")).toHaveCount(8);
  await page.getByLabel("Source", { exact: true }).selectOption("all");
  await page.getByLabel("Search bots", { exact: true }).fill("review");
  await expect(page.locator("[data-bot-template]")).toHaveCount(2);
  await page.getByLabel("Category", { exact: true }).selectOption("supervisor");
  await expect(page.locator("[data-bot-template]")).toHaveCount(1);
  await page.getByLabel("Search bots", { exact: true }).fill("no-such-bot");
  await expect(page.getByText("No bots match these filters.")).toBeVisible();
  await unchangedSession(page);
});

test("Add installs canonical ID only; Use reuses an edited saved copy and changes neither model nor global default", async ({ page }, info) => {
  await mount(page, { presets: [ownedBot()], defaultBotId: "owned-bot" });
  await builtin(page).getByRole("button", { name: "Add to My bots", exact: true }).click();
  expect((await calls(page, "presetInstallTemplate"))[0].args).toEqual(["coding"]);
  await expect(saved(page, "synora-template-coding-v1")).toBeVisible();
  await saved(page, "synora-template-coding-v1").getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Bot name", { exact: true }).fill("My edited built-in");
  await page.getByLabel("Bot instructions", { exact: true }).fill("MY EDITED INSTRUCTIONS");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  await builtin(page).getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.locator(".composer")).toBeVisible();
  expect((await calls(page, "newConversation")).map((c) => c.args)).toEqual([["owned-workspace", "synora-template-coding-v1"]]);
  const state = await page.evaluate(() => window.botHarness.state);
  expect(state.conversations[0].defaults?.bot?.instructions).toBe("MY EDITED INSTRUCTIONS");
  expect(state.preferences.defaultBotId).toBe("owned-bot");
  expect(state.preferences.view).toBe("workspace");
  await expect(page.locator(".bot-session-badge")).toHaveText("My edited built-in");
  await expect(page.locator(".bot-session-badge")).toHaveAttribute("title", "Active bot: My edited built-in");
  await page.setViewportSize({ width: 390, height: 950 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await expect(page.locator(".bot-session-badge")).toBeInViewport();
  await page.screenshot({ path: info.outputPath("active-bot-390.png") });
  await unchangedSession(page);
});

test("Use admission is single-shot, waits for draft persistence, and never sends a message", async ({ page }) => {
  await mount(page, { view: "workspace" });
  await page.evaluate(() => { window.botHarness.hold = "saveDraft"; });
  await page.getByLabel("Message", { exact: true }).fill("KEEP_DRAFT · pending");
  await expect.poll(async () => (await calls(page, "saveDraft")).length).toBe(1);
  // Controlled navigation while the already-started draft write is still unresolved.
  await page.evaluate(() => { window.botHarness.state.preferences.view = "bots"; window.botHarness.state.revision++; window.botHarness.resync(); });
  await expect(builtin(page)).toBeVisible();
  await builtin(page).getByRole("button", { name: "Use", exact: true }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await expect(builtin(page, "research").getByRole("button", { name: "Use", exact: true })).toBeDisabled();
  expect(await calls(page, "presetInstallTemplate")).toEqual([]);
  expect(await calls(page, "newConversation")).toEqual([]);
  await page.evaluate(() => window.botHarness.release());
  await expect(page.locator(".composer")).toBeVisible();
  expect(await calls(page, "newConversation")).toHaveLength(1);
  const sequence = (await page.evaluate(() => window.botHarness.calls)).map((c) => c.method);
  expect(sequence.indexOf("saveDraft")).toBeLessThan(sequence.indexOf("presetInstallTemplate"));
  expect(sequence.indexOf("presetInstallTemplate")).toBeLessThan(sequence.indexOf("newConversation"));
  await unchangedSession(page, "KEEP_DRAFT · pending");
});

for (const mode of ["running", "restorePending"] as const) test(`Use is disabled during ${mode}, including Standard`, async ({ page }) => {
  await mount(page, { [mode]: true, presets: [ownedBot()] });
  await expect(builtin(page).getByRole("button", { name: "Use", exact: true })).toBeDisabled();
  await expect(saved(page).getByRole("button", { name: "Use", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Use Standard", exact: true })).toBeDisabled();
  expect(await calls(page, "newConversation")).toEqual([]);
  if (mode === "restorePending") await page.evaluate(() => window.botHarness.release());
  else await page.evaluate(() => window.botHarness.updateEngine({ status: "idle" }));
  await expect(builtin(page).getByRole("button", { name: "Use", exact: true })).toBeEnabled();
  await unchangedSession(page);
});

test("Editor prevents double submit and pending dismissal, exposes failure and retains all legacy JSON fields", async ({ page }) => {
  await mount(page, { presets: [ownedBot()] });
  await saved(page).getByRole("button", { name: "Edit", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(page.getByLabel("Bot name", { exact: true })).toBeFocused();
  await expect(dialog.getByText("Legacy profile/context remain in JSON for compatibility; they do not control this session.")).toBeVisible();
  await expect(dialog.getByLabel("Profile", { exact: true })).toHaveCount(0);
  await expect(dialog.getByLabel("Context", { exact: true })).toHaveCount(0);
  await page.getByLabel("Bot instructions", { exact: true }).fill("UPDATED <script>plain text</script>");
  await page.evaluate(() => { window.botHarness.hold = "presetSave"; });
  await dialog.locator("form").evaluate((form) => { form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await expect(dialog.getByRole("button", { name: "Close bot editor" })).toBeDisabled();
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  expect(await calls(page, "presetSave")).toHaveLength(1);
  await page.evaluate(() => window.botHarness.release(true));
  await expect(dialog.getByRole("alert")).toHaveText("CONTROLLED presetSave failure");
  await expect(page.getByLabel("Bot instructions", { exact: true })).toHaveValue("UPDATED <script>plain text</script>");
  await dialog.getByRole("button", { name: "Save preset", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const value = (await calls(page, "presetSave"))[1].args[0] as Preset;
  expect(value.profile).toBe("high"); expect(value.context).toBe(1048576); expect(value.connectorIds).toEqual(["owned-connector"]);
  expect((await calls(page, "presetSave"))[1].args[1]).toBe("owned-bot");
  await unchangedSession(page);
});

test("Duplicate is a new collision-free copy; customization and modal keyboard focus restore work", async ({ page }) => {
  await mount(page, { presets: [ownedBot(), ownedBot({ id: "collision", name: "USER <Bot> {name} copy" })] });
  await saved(page).getByRole("button", { name: "Duplicate", exact: true }).click();
  await expect(page.getByLabel("Bot name", { exact: true })).toHaveValue("USER <Bot> {name} copy (2)");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  expect((await calls(page, "presetSave"))[0].args[1]).toBeUndefined();
  expect((await page.evaluate(() => window.botHarness.state)).presets).toHaveLength(3);
  const opener = builtin(page, "research").getByRole("button", { name: "Customize", exact: true });
  await opener.click();
  await expect(page.getByLabel("Bot name", { exact: true })).toBeFocused();
  await expect(page.getByLabel("Bot instructions", { exact: true })).toHaveValue(botTemplates.find((p) => p.id === "research")!.instructions);
  await page.getByRole("button", { name: "Save preset", exact: true }).focus(); await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Close bot editor" })).toBeFocused();
  await page.keyboard.press("Escape"); await expect(page.getByRole("dialog")).toHaveCount(0); await expect(opener).toBeFocused();
  await unchangedSession(page);
});

test("Saved bot Use/default/Standard are explicit; delete confirms and resets default without touching sessions", async ({ page }) => {
  await mount(page, { presets: [ownedBot()] });
  await saved(page).getByRole("button", { name: "Set default", exact: true }).click();
  expect((await calls(page, "preferences"))[0].args).toEqual([{ defaultBotId: "owned-bot" }]);
  await saved(page).getByRole("button", { name: "Use", exact: true }).click();
  await expect(page.locator(".composer")).toBeVisible();
  expect((await calls(page, "newConversation"))[0].args).toEqual(["owned-workspace", "owned-bot"]);
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await page.getByRole("button", { name: "Use Standard", exact: true }).click();
  await expect(page.locator(".composer")).toBeVisible();
  expect((await calls(page, "newConversation"))[1].args).toEqual(["owned-workspace", null]);
  await expect(page.locator(".bot-session-badge")).toHaveCount(0);
  expect((await page.evaluate(() => window.botHarness.state)).conversations[0].defaults?.bot).toBeNull();
  await page.getByRole("button", { name: "Bots", exact: true }).click();
  await saved(page).getByRole("button", { name: "Delete preset", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText("The default will reset to Standard.");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(await calls(page, "presetDelete")).toEqual([]);
  await saved(page).getByRole("button", { name: "Delete preset", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Delete preset", exact: true }).click();
  await expect(saved(page)).toHaveCount(0);
  const state = await page.evaluate(() => window.botHarness.state);
  expect(state.preferences.defaultBotId).toBeNull();
  expect(state.conversations.find((c) => c.defaults?.bot?.id === "owned-bot")?.defaults?.bot?.instructions).toBe("KEEP_USER_INSTRUCTIONS");
  await unchangedSession(page);
});

test("Disabled, scheduled, event and supervisor presets expose honest capabilities; JSON import/export retain user content", async ({ page }) => {
  await mount(page, { presets: [ownedBot({ enabled: false }), ownedBot({ id: "schedule", name: "Scheduled USER", kind: "scheduled" }), ownedBot({ id: "event", name: "Event USER", kind: "event" })] });
  await expect(saved(page).getByRole("button", { name: "Use", exact: true })).toBeDisabled();
  await expect(saved(page).getByRole("button", { name: "Set default", exact: true })).toBeDisabled();
  for (const id of ["schedule", "event"]) await expect(saved(page, id)).toContainText("Manual only. Saved schedules and events do not run automatically.");
  await expect(builtin(page, "supervisor")).toContainText("Configure actual workers separately in Tutor mode. This preset does not spawn workers.");
  await saved(page).getByRole("button", { name: "Export", exact: true }).click();
  expect((await calls(page, "presetExport"))[0].args).toEqual(["owned-bot"]);
  await page.getByRole("button", { name: "Import JSON", exact: true }).click(); // User cancelled picker.
  expect((await page.evaluate(() => window.botHarness.state)).presets).toHaveLength(3);
  await page.evaluate(() => { window.botHarness.importValue = { invalid: true }; });
  await page.getByRole("button", { name: "Import JSON", exact: true }).click();
  await expect(page.locator(".bot-library").getByRole("alert")).toBeVisible();
  expect((await page.evaluate(() => window.botHarness.state)).presets).toHaveLength(3);
  await page.evaluate((value) => { window.botHarness.importValue = value; }, { ...templatePreset("coding"), name: "Imported USER", instructions: "NEVER TRANSLATE" });
  await page.getByRole("button", { name: "Import JSON", exact: true }).click();
  await expect(page.locator("[data-bot-id]").filter({ hasText: "Imported USER" })).toBeVisible();
  await unchangedSession(page);
});

test("Catalog uses cache only; manual refresh errors retain previous list; automatic status refreshes on resync", async ({ page }) => {
  await mount(page, { cached: true });
  await expect(page.locator("[data-agency-id]")).toHaveCount(1);
  expect((await calls(page, "botCatalogRead")).map((c) => c.args)).toEqual([[false]]);
  await page.getByLabel("Search bots", { exact: true }).fill("engineering");
  await expect(page.locator("[data-agency-id]")).toHaveCount(1);
  await page.getByRole("combobox", { name: "Category", exact: true }).selectOption("agency:engineering");
  await expect(page.locator("[data-bot-template]")).toHaveCount(0);
  expect(await calls(page, "botCatalogRead")).toHaveLength(1);
  await page.evaluate(() => { window.botHarness.fail = "botCatalogRead"; });
  await page.getByRole("button", { name: "Refresh catalog", exact: true }).click();
  await expect(page.locator(".bot-agency").getByRole("alert")).toContainText("Showing the previous cached catalog");
  await expect(page.locator("[data-agency-id]")).toHaveCount(1);
  expect((await calls(page, "botCatalogRead"))[1].args).toEqual([true]);
  await page.evaluate(() => { const h = window.botHarness; h.fail = null; h.updates = { checking: false, lastCheckedAt: 1789050000100, lastSuccessAt: 1789050000000, updated: 2, error: "CONTROLLED background update failed" }; h.resync(); });
  await expect(page.locator(".bot-agency")).toContainText("CONTROLLED background update failed");
  await expect(page.locator(".bot-agency")).toContainText("Updated bots: 2");
  expect((await calls(page, "botCatalogRead"))[2].args).toEqual([false]);
  await page.getByRole("switch", { name: "Automatic catalog updates", exact: true }).uncheck();
  expect((await calls(page, "preferences")).at(-1)?.args).toEqual([{ botCatalogAutomatic: false }]);
  await page.evaluate(() => window.botHarness.remount());
  await expect(page.getByRole("switch", { name: "Automatic catalog updates", exact: true })).not.toBeChecked();
  await unchangedSession(page);
});

test("Agency import requires explicit reviewed preview, exact content/license/token; pending errors preserve review", async ({ page }) => {
  await mount(page, { cached: true });
  await page.locator("[data-agency-id]").getByRole("heading").click();
  expect(await calls(page, "botCatalogPreview")).toEqual([]);
  expect(await calls(page, "botCatalogImport")).toEqual([]);
  await page.getByRole("button", { name: "Review profile", exact: true }).click();
  const dialog = page.getByRole("dialog"), preview = await page.evaluate(() => window.botHarness.preview);
  expect((await calls(page, "botCatalogPreview"))[0].args).toEqual([preview.entry.id, preview.revision]);
  for (const text of [preview.instructions, preview.original, preview.licenseText]) await expect(dialog.locator("pre").filter({ hasText: text })).toHaveText(text);
  await expect(dialog).toContainText(preview.sourceUrl); await expect(dialog).toContainText(preview.sha256); await expect(dialog).toContainText(preview.warnings[0]);
  await expect(dialog.locator("script")).toHaveCount(0);
  await expect(dialog.getByRole("button", { name: "Import reviewed bot" })).toBeDisabled();
  await dialog.getByRole("checkbox").check();
  await page.evaluate(() => { window.botHarness.hold = "botCatalogImport"; });
  await dialog.getByRole("button", { name: "Import reviewed bot" }).evaluate((button: HTMLButtonElement) => { button.click(); button.click(); });
  await page.keyboard.press("Escape"); await expect(dialog).toBeVisible();
  expect(await calls(page, "botCatalogImport")).toHaveLength(1);
  await page.evaluate(() => window.botHarness.release(true));
  await expect(dialog.getByRole("alert")).toHaveText("CONTROLLED botCatalogImport failure");
  await dialog.getByRole("button", { name: "Import reviewed bot" }).click();
  await expect(dialog).toHaveCount(0);
  expect((await calls(page, "botCatalogImport"))[1].args).toEqual([preview.id, true]);
  await expect(saved(page, "agency-owned")).toContainText("Managed import");
  expect(await calls(page, "newConversation")).toEqual([]);
  await saved(page, "agency-owned").getByRole("button", { name: "View instructions", exact: true }).click();
  await expect(page.getByRole("dialog")).toContainText(preview.sourceUrl);
  await expect(page.getByRole("dialog").locator("pre").filter({ hasText: preview.licenseText })).toHaveText(preview.licenseText);
  await page.keyboard.press("Escape");
  await saved(page, "agency-owned").getByRole("button", { name: "Edit", exact: true }).click();
  await page.getByLabel("Bot instructions", { exact: true }).fill("MY LOCAL FORK");
  await page.getByRole("button", { name: "Save preset", exact: true }).click();
  expect((await calls(page, "presetSave"))[0].args[1]).toBeUndefined();
  const state = await page.evaluate(() => window.botHarness.state);
  expect(state.presets.find((p) => p.id === "agency-owned")?.instructions).toBe(preview.instructions);
  expect(state.presets.find((p) => p.instructions === "MY LOCAL FORK")?.source?.managed).toBe(false);
  await expect(page.locator("[data-bot-id]").filter({ hasText: "Customized import" })).toBeVisible();
  await unchangedSession(page);
});

for (const locale of localeSchema.options) test(`Seven-locale labels, verbatim user/remote content and 390px keyboard layout: ${locale}`, async ({ page }, info) => {
  const t = (source: string) => translate(messages, locale, source);
  await page.setViewportSize({ width: 390, height: 950 });
  await mount(page, { locale, cached: true, presets: [ownedBot()] });
  await expect(page.locator("html")).toHaveAttribute("lang", locale);
  for (const [id, labels] of Object.entries(templateLabels)) {
    await expect(builtin(page, id).getByRole("heading")).toHaveText(t(labels.name));
    await expect(builtin(page, id)).toContainText(t(labels.description));
    await expect(builtin(page, id).getByRole("button", { name: t("View instructions"), exact: true })).toBeVisible();
  }
  await expect(saved(page).getByRole("heading")).toHaveText("USER <Bot> {name}");
  await expect(page.locator("[data-agency-id]").getByRole("heading")).toHaveText("Agency <Evidence> {name}");
  await expect(page.getByRole("switch", { name: t("Automatic catalog updates") })).toBeVisible();
  await contained(page);
  await builtin(page).getByRole("button", { name: t("View instructions"), exact: true }).click();
  await expect(page.getByRole("dialog").locator("pre")).toHaveText(botTemplates[0].instructions);
  await page.keyboard.press("Escape");
  await saved(page).getByRole("button", { name: t("Edit"), exact: true }).click();
  await expect(page.getByLabel(t("Bot name"), { exact: true })).toHaveValue("USER <Bot> {name}");
  await expect(page.getByLabel(t("Bot instructions"), { exact: true })).toHaveValue("KEEP_USER_INSTRUCTIONS");
  await expect(page.getByLabel(t("Bot name"), { exact: true })).toBeFocused();
  expect(await page.locator(".bot-modal").evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  if (locale === "de") await page.screenshot({ path: info.outputPath("bot-editor-de-390.png") });
  await page.keyboard.press("Escape");
  await unchangedSession(page);
});
