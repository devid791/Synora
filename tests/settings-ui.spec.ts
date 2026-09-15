import { test, expect, _electron, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import type {} from "./fixtures/settings-ui";
import { messages } from "../src/renderer/locales/settings";
import { translate } from "../src/renderer/i18n";
import { localeSchema } from "../src/shared/locale";
let script: string, css: string, brand: string, lightBrand: string;
test.beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["tests/fixtures/settings-ui.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  css = (await readFile("src/renderer/style.css", "utf8")).replace(
    /^@import.*$/gm,
    "",
  );
  brand = await readFile("public/brand/synora.svg", "utf8");
  lightBrand = await readFile("public/brand/synora-light.svg", "utf8");
});
async function mount(
  page: Page,
  preferences = {},
  platform: "web" | "linux" | "darwin" = "web",
  options = {},
) {
  await page.route("**/*", (route) => route.abort());
  await page.route(
    /http:\/\/settings-fixture\.invalid\/brand\/synora(?:-light)?\.svg$/,
    (route) => route.fulfill({ contentType: "image/svg+xml", body: route.request().url().endsWith("synora-light.svg") ? lightBrand : brand }),
  );
  await page.setContent(
    '<base href="http://settings-fixture.invalid/"><div id="root"></div>',
  );
  await page.addStyleTag({ content: css });
  await page.evaluate(
    ({ preferences, platform, options }) => {
      window.settingsOptions = { preferences, platform, ...options };
    },
    { preferences, platform, options },
  );
  await page.addScriptTag({ content: script });
  await expect(page.locator(".general-settings")).toBeVisible();
}
const theme = async (page: Page, value: string) => {
  await expect(page.locator("html")).toHaveAttribute("data-theme", value);
  const logo = page.locator(".brand img");
  await expect(logo).toHaveAttribute("src", value === "light" ? "./brand/synora-light.svg" : "./brand/synora.svg");
  await expect.poll(() => logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 1437)).toBe(true);
  await expect(logo).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  await expect(logo).toHaveCSS("padding", "0px");
};
async function intact(page: Page) {
  const h = await page.evaluate(() => window.settingsHarness);
  const c = h.state.conversations.find((c) => c.id === "owned-session")!;
  expect(c.draft).toBe("KEEP_DRAFT");
  expect(c.defaults).toEqual({ permission: "ask", bot: null });
  expect(h.calls.filter((c) => /^engine/.test(c.method))).toEqual([]);
  expect(h.unexpected).toEqual([]);
}
test("Browser: saved Light/Dark/System, OS listener, navigation and remount", async ({
  page,
}, info) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await mount(page);
  await theme(page, "dark");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await theme(page, "light");
  await expect(page.locator("html")).toHaveCSS("color-scheme", "light");
  await expect(page.locator(".sidebar")).toHaveCSS(
    "background-color",
    "rgb(238, 241, 246)",
  );
  await page.screenshot({ path: info.outputPath("settings-light.png") });
  await page.locator(".brand").screenshot({ path: info.outputPath("brand-light.png") });
  await page.emulateMedia({ colorScheme: "light" });
  await page.emulateMedia({ colorScheme: "dark" });
  await theme(page, "light");
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await theme(page, "light");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.evaluate(() => window.settingsHarness.remount());
  await expect(
    page.getByRole("button", { name: "Light", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Dark", exact: true }).click();
  await theme(page, "dark");
  await page.screenshot({ path: info.outputPath("settings-dark.png") });
  await page.locator(".brand").screenshot({ path: info.outputPath("brand-dark.png") });
  await page.getByRole("button", { name: "System", exact: true }).click();
  const before = await page.evaluate(() => window.settingsHarness.calls.length);
  await page.emulateMedia({ colorScheme: "light" });
  await theme(page, "light");
  await page.emulateMedia({ colorScheme: "dark" });
  await theme(page, "dark");
  expect(await page.evaluate(() => window.settingsHarness.calls.length)).toBe(
    before,
  );
  await intact(page);
});
test("Pending and rejected settings retain real selection across navigation; retry persists", async ({
  page,
}) => {
  await mount(page, { theme: "dark" });
  await page.evaluate(() => {
    window.settingsHarness.hold = true;
  });
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await expect(
    page.locator(".general-settings").getByRole("status"),
  ).toHaveText("Saving preferences…");
  await expect(
    page.locator(".general-settings").getByRole("status"),
  ).toBeInViewport();
  await theme(page, "dark");
  await expect(
    page.getByRole("button", { name: "Dark", exact: true }),
  ).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByLabel("Default bot", { exact: true })).toBeDisabled();
  await expect(page.getByTestId("app-language")).toBeDisabled();
  await page.evaluate(() => {
    window.settingsHarness.hold = false;
  });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Light", exact: true }),
  ).toBeDisabled();
  await page.evaluate(() => window.settingsHarness.release(true));
  await expect(
    page.locator(".general-settings").getByRole("alert"),
  ).toContainText("CONTROLLED storage failure");
  await expect(
    page.locator(".general-settings").getByRole("alert"),
  ).toBeInViewport();
  await theme(page, "dark");
  await page.getByRole("button", { name: "Light", exact: true }).click();
  await theme(page, "light");
  await page.evaluate(() => {
    window.settingsHarness.fail = true;
  });
  await page
    .getByLabel("Default bot", { exact: true })
    .selectOption("owned-bot");
  await expect(page.getByLabel("Default bot", { exact: true })).toHaveValue("");
  await expect(
    page.locator(".general-settings").getByRole("alert"),
  ).toContainText("Your previous setting is unchanged");
  await intact(page);
});
test("Default bot and confirmed permissions affect only a newly created session", async ({
  page,
}) => {
  await mount(page);
  const bot = page.getByLabel("Default bot", { exact: true });
  await expect(bot.locator("option")).toHaveCount(2);
  await bot.selectOption("owned-bot");
  await expect(bot).toHaveValue("owned-bot");
  await page.locator(".general-settings .permission-trigger").click();
  await page.locator('[data-permission-option="full"]').click();
  await page.getByRole("button", { name: "Keep current permissions" }).click();
  expect(
    (await page.evaluate(() => window.settingsHarness.state)).preferences
      .permission,
  ).toBeUndefined();
  await page.locator(".general-settings .permission-trigger").click();
  await page.locator('[data-permission-option="auto-review"]').click();
  await intact(page);
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(page.locator(".composer .permission-trigger")).toHaveAttribute(
    "data-permission",
    "ask",
  );
  await page
    .getByRole("button", { name: "New conversation", exact: true })
    .click();
  const h = await page.evaluate(() => window.settingsHarness);
  expect(h.state.conversations[0].defaults?.permission).toBe("auto-review");
  expect(h.state.conversations[0].defaults?.bot?.id).toBe("owned-bot");
  await expect(page.locator(".composer .permission-trigger")).toHaveAttribute(
    "data-permission",
    "auto-review",
  );
  await intact(page);
});
for (const locale of localeSchema.options)
  test(`All settings localized, one language picker, narrow keyboard layout: ${locale}`, async ({
    page,
  }, info) => {
    await page.setViewportSize({ width: 390, height: 950 });
    await mount(page, { locale, theme: "light" });
    const label = (key: string) => translate(messages, locale, key);
    await expect(
      page.getByRole("heading", { name: label("General"), exact: true }),
    ).toBeVisible();
    await expect(page.getByTestId("app-language")).toHaveCount(1);
    const bot = page.getByLabel(label("Default bot"), { exact: true });
    await bot.selectOption("owned-bot");
    await expect(bot.locator("option:checked")).toHaveText(
      "Owned <Bot> {identity}",
    );
    const dark = page.getByRole("button", { name: label("Dark"), exact: true });
    await dark.focus();
    await page.keyboard.press("Enter");
    await expect(dark).toHaveAttribute("aria-pressed", "true");
    await theme(page, "dark");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const bounds = await page.locator(".appearance-options").boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    if (locale === "de")
      await page.screenshot({
        path: info.outputPath("settings-narrow-de.png"),
      });
    await intact(page);
  });
test("Native Electron: real OS theme listener and saved override on renderer remount", async () => {
  const userData = await mkdtemp(join(tmpdir(), "synora-settings-ui-"));
  const app = await _electron.launch({
    args: [resolve("tests/fixtures/settings-native.cjs"), "--no-sandbox"],
    colorScheme: null,
    env: { ...process.env, SYNORA_SETTINGS_USER_DATA: userData },
  });
  try {
    const page = await app.firstWindow();
    await mount(page, {}, "linux");
    await theme(page, "dark");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await theme(page, "light");
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await theme(page, "dark");
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "light";
    });
    await theme(page, "dark");
    await page.evaluate(() => window.settingsHarness.remount());
    await expect(
      page.getByRole("button", { name: "Dark", exact: true }),
    ).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "System", exact: true }).click();
    await theme(page, "light");
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await app.evaluate(({ nativeTheme }) => {
      nativeTheme.themeSource = "dark";
    });
    await theme(page, "light");
    await intact(page);
  } finally {
    await app.close();
    await rm(userData, { recursive: true, force: true });
  }
});

for (const platform of ["web", "linux", "darwin"] as const)
  test(`Unverified native capabilities are explained, without fake switches: ${platform}`, async ({
    page,
  }) => {
    await mount(page, {}, platform);
    for (const label of ["Launch at login", "System notifications"]) {
      const row = page.getByRole("group", { name: label, exact: true });
      await expect(row).toContainText(
        "This host has no verified native integration",
      );
      await expect(row.getByRole("switch")).toHaveCount(0);
      await expect(row.getByRole("checkbox")).toHaveCount(0);
    }
    await intact(page);
  });

test("Verified native controls: off/on defaults, pending, OS rejection, retry and persistence", async ({
  page,
}) => {
  await mount(page, {}, "darwin", { nativeSupported: true });
  const launch = page.getByRole("switch", {
    name: "Launch at login",
    exact: true,
  });
  const notifications = page.getByRole("switch", {
    name: "System notifications",
    exact: true,
  });
  await expect(launch).not.toBeChecked();
  await expect(notifications).toBeChecked();
  await page.evaluate(() => {
    window.settingsHarness.hold = true;
  });
  await launch.click();
  await expect(launch).not.toBeChecked();
  await expect(launch).toBeDisabled();
  await expect(notifications).toBeDisabled();
  await expect(
    page.locator(".general-settings").getByRole("status"),
  ).toBeInViewport();
  await page.evaluate(() => {
    window.settingsHarness.hold = false;
    window.settingsHarness.release(true);
  });
  await expect(
    page.locator(".general-settings").getByRole("alert"),
  ).toContainText("CONTROLLED storage failure");
  await expect(launch).not.toBeChecked();
  await launch.click();
  await expect(launch).toBeChecked();
  await notifications.click();
  await expect(notifications).not.toBeChecked();
  await page.evaluate(() => window.settingsHarness.remount());
  await expect(launch).toBeChecked();
  await expect(notifications).not.toBeChecked();
  const writes = (
    await page.evaluate(() => window.settingsHarness.calls)
  ).filter((c) => c.method === "preferences");
  expect(writes.map((c) => c.args[0])).toEqual([
    { launchAtLogin: true },
    { launchAtLogin: true },
    { systemNotifications: false },
  ]);
  await intact(page);
});

for (const behavior of ["queue", "steer"] as const)
  test(`Busy Enter uses saved ${behavior} and exact turn IDs; Shift+Enter/IME do not submit`, async ({
    page,
  }) => {
    await mount(page, {}, "web", { running: true });
    await page
      .getByLabel("Enter while working", { exact: true })
      .selectOption(behavior);
    await page.evaluate(() => window.settingsHarness.remount());
    await expect(
      page.getByLabel("Enter while working", { exact: true }),
    ).toHaveValue(behavior);
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("CONTROLLED guidance");
    await input.press("Shift+Enter");
    await input.dispatchEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
    });
    expect(
      (await page.evaluate(() => window.settingsHarness.calls)).filter(
        (c) => c.method === "engineStart",
      ),
    ).toHaveLength(0);
    await expect(input).toHaveValue("CONTROLLED guidance\n");
    await input.press("Enter");
    await expect(input).toHaveValue("");
    const calls = (
      await page.evaluate(() => window.settingsHarness.calls)
    ).filter((c) => c.method === "engineStart");
    expect(calls).toEqual([
      {
        method: "engineStart",
        args: [
          "owned-session",
          "CONTROLLED guidance\n",
          "text",
          {
            behavior,
            expectedThreadId: "owned-thread",
            expectedTurnId: "owned-turn",
          },
        ],
      },
    ]);
    if (behavior === "queue") {
      await expect(
        page.getByRole("region", { name: "Queued messages" }),
      ).toContainText("CONTROLLED guidance");
      await page.evaluate(() => {
        const h = window.settingsHarness;
        h.state.conversations[0].queuedMessages![0].status = "held";
        h.state.revision++;
        h.updateEngine({});
      });
      await expect(
        page.getByRole("region", { name: "Queued messages" }),
      ).toContainText("Held for review — not sent automatically");
    }
    expect(
      await page.evaluate(() => window.settingsHarness.unexpected),
    ).toEqual([]);
  });

test("Busy submission pending/rejection retains draft, prevents duplicate Enter and preserves newer typing", async ({
  page,
}) => {
  await mount(page, {}, "web", { running: true });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await page.evaluate(() => {
    window.settingsHarness.holdSubmission = true;
  });
  await input.fill("RETAIN on rejection");
  await input.press("Enter");
  await expect(page.locator(".busy-message-status")).toHaveText(
    "Submitting message…",
  );
  await input.press("Enter");
  await expect(input).toHaveValue("RETAIN on rejection");
  expect(
    (await page.evaluate(() => window.settingsHarness.calls)).filter(
      (c) => c.method === "engineStart",
    ),
  ).toHaveLength(1);
  await page.evaluate(() => window.settingsHarness.releaseSubmission(true));
  await expect(page.getByRole("alert")).toContainText("CONTROLLED stale turn");
  await expect(input).toHaveValue("RETAIN on rejection");
  await input.press("Enter");
  await expect(page.locator(".busy-message-status")).toHaveText(
    "Submitting message…",
  );
  await input.fill("NEWER_DRAFT");
  await page.evaluate(() => window.settingsHarness.releaseSubmission());
  await expect(
    page.getByRole("region", { name: "Queued messages" }),
  ).toContainText("RETAIN on rejection");
  await expect(input).toHaveValue("NEWER_DRAFT");
  expect(
    (await page.evaluate(() => window.settingsHarness.calls)).filter(
      (c) => c.method === "engineStart",
    ),
  ).toHaveLength(2);
});

test("Busy Enter cannot target another conversation, cleanup, disconnected Core or draft images", async ({
  page,
}) => {
  await mount(page, {}, "web", { running: true });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  for (const patch of [
    { cleanupPending: true },
    { cleanupPending: false, connection: "disconnected" as const },
    { connection: "live" as const, conversationId: "another-session" },
  ]) {
    await page.evaluate(
      (patch) => window.settingsHarness.updateEngine(patch),
      patch,
    );
    await expect(page.locator(".busy-message-status")).toHaveCount(0);
    await input.press("Enter");
  }
  await page.evaluate(() => {
    const h = window.settingsHarness;
    h.state.conversations[0].draftImageIds = ["image-not-uploaded"];
    h.state.revision++;
    h.updateEngine({ conversationId: "owned-session" });
  });
  await expect(page.getByRole("alert")).toContainText(
    "Draft image unavailable",
  );
  await input.press("Enter");
  expect(
    (await page.evaluate(() => window.settingsHarness.calls)).filter(
      (c) => c.method === "engineStart",
    ),
  ).toHaveLength(0);
  await expect(input).toHaveValue("KEEP_DRAFT");
});

for (const preference of ["queue", "steer"] as const)
  test(`Visible Send now / Queue actions are explicit with ${preference} default and preserve turn identity`, async ({ page }) => {
    await mount(page, { busyEnterBehavior: preference }, "web", { running: true });
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    const actions = page.locator(".busy-message-actions");
    await input.fill("");
    await expect(actions.getByRole("button", { name: "Send now", exact: true })).toBeDisabled();
    await expect(actions.getByRole("button", { name: "Queue", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Cancel turn", exact: true })).toBeEnabled();
    for (const [label, behavior] of [["Send now", "steer"], ["Queue", "queue"]] as const) {
      await input.fill(`CONTROLLED ${behavior}`);
      await actions.getByRole("button", { name: label, exact: true }).click();
      await expect(input).toHaveValue("");
      await expect(page.locator(".busy-message-receipt")).toHaveText(behavior === "steer"
        ? "Sent to the active turn." : "Queued — after the current turn");
      const calls = (await page.evaluate(() => window.settingsHarness.calls)).filter(c => c.method === "engineStart");
      expect(calls.at(-1)?.args).toEqual(["owned-session", `CONTROLLED ${behavior}`, "text", {
        behavior, expectedThreadId: "owned-thread", expectedTurnId: "owned-turn",
      }]);
      if (behavior === "steer") await expect(page.locator(".queued-message")).toHaveCount(0);
      else await expect(page.locator(".queued-message")).toHaveText(/CONTROLLED queue/);
    }
    const h = await page.evaluate(() => window.settingsHarness);
    expect(h.state.preferences.busyEnterBehavior).toBe(preference);
    expect(h.state.conversations.map(c => c.id)).toEqual(["owned-session"]);
    expect(h.calls.filter(c => /^(newConversation|engineCancel|engineConfigure)$/.test(c.method))).toEqual([]);
    expect(h.calls.filter(c => c.method === "engineStart")).toHaveLength(2);
    expect(h.unexpected).toEqual([]);
    await page.evaluate(() => window.settingsHarness.updateEngine({ turnId: "next-owned-turn" }));
    await expect(page.locator(".busy-message-receipt")).toHaveCount(0);
  });

test("Send now waits for acknowledgement, retains a rejected draft and never discards newer typing", async ({ page }) => {
  await mount(page, {}, "web", { running: true });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const send = page.getByRole("button", { name: "Send now", exact: true });
  await page.evaluate(() => { window.settingsHarness.holdSubmission = true; });
  await input.fill("GUIDANCE WHILE BUSY");
  await send.click();
  await expect(send).toBeDisabled();
  await expect(page.locator(".busy-message-actions").getByRole("button", { name: "Queue", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Cancel turn", exact: true })).toBeEnabled();
  await expect(page.locator(".busy-message-status")).toHaveText("Submitting message…");
  await expect(page.locator(".busy-message-receipt")).toHaveCount(0);
  await input.press("Control+Enter");
  await page.evaluate(() => window.settingsHarness.releaseSubmission(true));
  await expect(page.getByRole("alert")).toContainText("CONTROLLED stale turn");
  await expect(input).toHaveValue("GUIDANCE WHILE BUSY");
  await expect(page.locator(".busy-message-receipt")).toHaveCount(0);
  expect((await page.evaluate(() => window.settingsHarness.calls)).filter(c => c.method === "engineStart")).toHaveLength(1);
  await send.click();
  await expect(send).toBeDisabled();
  await input.fill("NEWER UNSENT DRAFT");
  await page.evaluate(() => window.settingsHarness.releaseSubmission());
  await expect(page.locator(".busy-message-receipt")).toHaveText("Sent to the active turn.");
  await expect(input).toHaveValue("NEWER UNSENT DRAFT");
  const h = await page.evaluate(() => window.settingsHarness);
  expect(h.calls.filter(c => c.method === "engineStart")).toHaveLength(2);
  expect(h.state.conversations).toHaveLength(1);
  expect(h.unexpected).toEqual([]);
});

test("Busy actions remain compact and translated in light/dark at desktop and narrow widths", async ({ page }, info) => {
  await mount(page, {}, "web", { running: true });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  for (const [width, height] of [[1440, 800], [1024, 700], [900, 640], [390, 980]]) {
    await page.setViewportSize({ width, height });
    for (const theme of ["light", "dark"] as const) {
      for (const locale of localeSchema.options) {
        await page.evaluate(({ locale, theme }) => {
          const h = window.settingsHarness;
          Object.assign(h.state.preferences, { locale, theme });
          h.state.revision++;
          h.updateEngine({});
        }, { locale, theme });
        const actions = page.locator(".busy-message-actions");
        await expect(actions.getByRole("button", { name: translate(messages, locale, "Send now"), exact: true })).toBeVisible();
        await expect(actions.getByRole("button", { name: translate(messages, locale, "Queue"), exact: true })).toBeVisible();
        for (const button of await actions.getByRole("button").all()) {
          const bounds = (await button.boundingBox())!;
          expect(bounds.x).toBeGreaterThanOrEqual(0);
          expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
          expect(bounds.y + bounds.height).toBeLessThanOrEqual(height);
        }
      }
      await page.screenshot({ path: info.outputPath(`busy-actions-${width}-${theme}.png`) });
    }
  }
});

test("Legacy sessions keep their actual Ask policy; explicit composer permission updates the same session", async ({
  page,
}) => {
  await mount(page, { permission: "auto-review" });
  await page.evaluate(() => {
    const h = window.settingsHarness;
    delete h.state.conversations[0].defaults;
    h.state.revision++;
    h.updateEngine({});
  });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const trigger = page.locator(".composer .permission-trigger");
  await expect(trigger).toHaveAttribute("data-permission", "ask");
  await trigger.click();
  const before = await page.evaluate(() => structuredClone(window.settingsHarness.state.conversations));
  await page.locator('[data-permission-option="auto-review"]').click();
  await expect(trigger).toHaveAttribute("data-permission", "auto-review");
  const h = await page.evaluate(() => window.settingsHarness);
  expect(h.state.conversations[0].defaults?.permission).toBe("auto-review");
  expect(h.state.conversations.map(c => c.id)).toEqual(before.map(c => c.id));
  expect(h.state.conversations[0].draft).toBe("KEEP_DRAFT");
  expect(h.state.conversations[0].messages).toEqual(before[0].messages);
  expect(h.calls.filter(c => c.method === "newConversation")).toHaveLength(0);
  expect(h.unexpected).toEqual([]);
});

async function seedRemovalQueue(page: Page) {
  await page.evaluate(() => {
    const h = window.settingsHarness;
    h.state.conversations[0].queuedMessages = (
      ["queued", "held", "dispatching"] as const
    ).map((status, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index + 1}`,
      text: "SAME_QUEUED_TEXT {do_not_translate}",
      threadId: "owned-thread",
      sessionId: "owned-core-session",
      afterTurnId: "owned-turn",
      status,
    }));
    h.state.revision++;
    h.updateEngine({});
  });
  await expect(page.locator(".queued-message")).toHaveCount(3);
}

test("Queue removal is explicit, identity-scoped and honest across pending, rejection and navigation", async ({
  page,
}) => {
  await mount(page, {}, "web", { running: true });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await seedRemovalQueue(page);
  const first = page.locator(
    '[data-queued-message-id="00000000-0000-4000-8000-000000000001"]',
  );
  const remove = first.getByRole("button", {
    name: "Remove queued message",
    exact: true,
  });
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  const dispatching = page.locator('[data-queue-status="dispatching"]');
  await expect(
    dispatching.getByRole("button", { name: "Remove queued message" }),
  ).toBeDisabled();
  await expect(dispatching.getByRole("button")).toHaveAttribute(
    "title",
    "This message is already being sent and cannot be removed.",
  );
  await page.evaluate(() => {
    window.settingsHarness.holdDiscard = true;
  });
  await remove.click();
  await expect(first.getByRole("status")).toHaveText(
    "Removing queued message…",
  );
  await expect(first).toContainText("SAME_QUEUED_TEXT {do_not_translate}");
  await expect(remove).toBeDisabled();
  await expect(
    page
      .locator('[data-queue-status="held"]')
      .getByRole("button", { name: "Remove queued message" }),
  ).toBeDisabled();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await expect(remove).toBeDisabled();
  expect(
    (await page.evaluate(() => window.settingsHarness.calls)).filter(
      (c) => c.method === "discardQueuedMessage",
    ),
  ).toHaveLength(1);
  await page.evaluate(() => {
    window.settingsHarness.holdDiscard = false;
    window.settingsHarness.releaseDiscard(true);
  });
  await expect(page.getByRole("alert")).toContainText(
    "CONTROLLED discard failure",
  );
  await expect(page.locator(".queued-message")).toHaveCount(3);
  await expect(draft).toHaveValue("KEEP_DRAFT");
  await remove.click();
  await expect(first).toHaveCount(0);
  await expect(page.locator(".queued-message")).toHaveCount(2);
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("KEEP_DRAFT");
  const h = await page.evaluate(() => window.settingsHarness);
  expect(
    h.calls
      .filter((c) => c.method === "discardQueuedMessage")
      .map((c) => c.args),
  ).toEqual([
    ["owned-session", "00000000-0000-4000-8000-000000000001"],
    ["owned-session", "00000000-0000-4000-8000-000000000001"],
  ]);
  expect(h.state.conversations[0].queuedMessages?.map((m) => m.id)).toEqual([
    "00000000-0000-4000-8000-000000000002",
    "00000000-0000-4000-8000-000000000003",
  ]);
  expect(h.unexpected).toEqual([]);
});

test("Held messages add to drafts without replacing or consuming text, even after send; only explicit discard removes them", async ({
  page,
}) => {
  await mount(page, { busyEnterBehavior: "steer" }, "web", { running: true });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await seedRemovalQueue(page);
  const held = page.locator('[data-queue-status="held"]');
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await held.getByRole("button", { name: "Add held message to draft" }).click();
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue(
    "KEEP_DRAFT\n\nSAME_QUEUED_TEXT {do_not_translate}",
  );
  await expect(held).toHaveCount(1);
  expect(
    (await page.evaluate(() => window.settingsHarness.calls)).filter(
      (c) => c.method === "discardQueuedMessage",
    ),
  ).toHaveLength(0);
  await draft.fill("");
  await held.getByRole("button", { name: "Add held message to draft" }).click();
  await expect(draft).toHaveValue("SAME_QUEUED_TEXT {do_not_translate}");
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => window.settingsHarness.state))
          .conversations[0].draft,
    )
    .toBe("SAME_QUEUED_TEXT {do_not_translate}");
  await page.evaluate(() => window.settingsHarness.remount());
  await expect(draft).toHaveValue("SAME_QUEUED_TEXT {do_not_translate}");
  await expect(held).toHaveCount(1);
  await draft.press("Enter");
  await expect(draft).toHaveValue("");
  await expect(held).toHaveCount(1);
  await expect(page.locator(".queued-message")).toHaveCount(3);
  await held.getByRole("button", { name: "Add held message to draft" }).click();
  await held.getByRole("button", { name: "Remove queued message" }).click();
  await expect(held).toHaveCount(0);
  await expect(draft).toHaveValue("SAME_QUEUED_TEXT {do_not_translate}");
  await expect(page.locator(".queued-message")).toHaveCount(2);
  const h = await page.evaluate(() => window.settingsHarness);
  expect(
    h.calls
      .filter((c) => c.method === "discardQueuedMessage")
      .map((c) => c.args),
  ).toEqual([["owned-session", "00000000-0000-4000-8000-000000000002"]]);
  expect(h.unexpected).toEqual([]);
});

test("A dispatch race rejects queue removal and keeps the message and draft visible", async ({
  page,
}) => {
  await mount(page, {}, "web", { running: true });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await seedRemovalQueue(page);
  const row = page.locator(
    '[data-queued-message-id="00000000-0000-4000-8000-000000000001"]',
  );
  await page.evaluate(() => {
    window.settingsHarness.holdDiscard = true;
  });
  await row.getByRole("button", { name: "Remove queued message" }).click();
  await expect(row.getByRole("status")).toBeVisible();
  await page.evaluate(() => {
    const h = window.settingsHarness;
    h.state.conversations[0].queuedMessages![0].status = "dispatching";
    h.state.revision++;
    h.updateEngine({});
    h.releaseDiscard();
  });
  await expect(page.getByRole("alert")).toContainText(
    "CONTROLLED message is dispatching",
  );
  await expect(row).toHaveAttribute("data-queue-status", "dispatching");
  await expect(
    row.getByRole("button", { name: "Remove queued message" }),
  ).toBeDisabled();
  await expect(page.locator(".queued-message")).toHaveCount(3);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("KEEP_DRAFT");
});

test("Queue actions are localized, keyboard-accessible and fit the narrow layout", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 950 });
  await mount(page, { theme: "light" }, "web", { running: true });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  await seedRemovalQueue(page);
  for (const locale of localeSchema.options) {
    await page.evaluate((locale) => {
      const h = window.settingsHarness;
      h.state.preferences.locale = locale;
      h.state.revision++;
      h.updateEngine({});
    }, locale);
    const label = (key: string) => translate(messages, locale, key);
    const held = page.locator('[data-queue-status="held"]');
    const add = held.getByRole("button", {
      name: label("Add held message to draft"),
      exact: true,
    });
    const remove = held.getByRole("button", {
      name: label("Remove queued message"),
      exact: true,
    });
    await add.focus();
    await expect(add).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(remove).toBeFocused();
    const bounds = await remove.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
    await expect(held).toContainText("SAME_QUEUED_TEXT {do_not_translate}");
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

for (const preference of ["queue", "steer"] as const)
  test(`Busy modifier override: ${preference}, Ctrl/Cmd use the other action; form keeps the preference`, async ({
    page,
  }) => {
    await mount(page, { busyEnterBehavior: preference }, "web", {
      running: true,
    });
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    const other = preference === "queue" ? "steer" : "queue";
    await expect(page.locator(".busy-message-status")).toHaveText(
      preference === "queue"
        ? "Enter queues your text. Cmd/Ctrl+Enter steers the active turn. Shift+Enter adds a new line."
        : "Enter steers the active turn. Cmd/Ctrl+Enter queues your text. Shift+Enter adds a new line.",
    );
    await input.fill("KEEP_COMPOSING");
    for (const modifiers of [{}, { ctrlKey: true }, { metaKey: true }])
      await input.dispatchEvent("keydown", {
        key: "Enter",
        isComposing: true,
        bubbles: true,
        ...modifiers,
      });
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("KEEP_COMPOSING\n");
    expect(
      (await page.evaluate(() => window.settingsHarness.calls)).filter(
        (c) => c.method === "engineStart",
      ),
    ).toHaveLength(0);
    const choices = [
      ["Enter", preference],
      ["Control+Enter", other],
      ["Meta+Enter", other],
      ["form", preference],
    ] as const;
    for (const [key, behavior] of choices) {
      await input.fill(`CONTROLLED ${key}`);
      if (key === "form")
        await page.locator("form.composer").dispatchEvent("submit");
      else await input.press(key);
      await expect(input).toHaveValue("");
      const calls = (
        await page.evaluate(() => window.settingsHarness.calls)
      ).filter((c) => c.method === "engineStart");
      expect(calls.at(-1)?.args).toEqual([
        "owned-session",
        `CONTROLLED ${key}`,
        "text",
        {
          behavior,
          expectedThreadId: "owned-thread",
          expectedTurnId: "owned-turn",
        },
      ]);
    }
    expect(
      (await page.evaluate(() => window.settingsHarness.state)).preferences
        .busyEnterBehavior,
    ).toBe(preference);
    expect(
      (await page.evaluate(() => window.settingsHarness.calls)).filter(
        (c) => c.method === "engineStart",
      ),
    ).toHaveLength(4);
    for (const locale of localeSchema.options) {
      await page.evaluate((locale) => {
        const h = window.settingsHarness;
        h.state.preferences.locale = locale;
        h.state.revision++;
        h.updateEngine({});
      }, locale);
      await expect(page.locator(".busy-message-status")).toHaveText(
        translate(
          messages,
          locale,
          preference === "queue"
            ? "Enter queues your text. Cmd/Ctrl+Enter steers the active turn. Shift+Enter adds a new line."
            : "Enter steers the active turn. Cmd/Ctrl+Enter queues your text. Shift+Enter adds a new line.",
        ),
      );
    }
    expect(
      await page.evaluate(() => window.settingsHarness.unexpected),
    ).toEqual([]);
  });

test("Busy modifier support does not change idle Enter/Ctrl/Cmd/form submission", async ({
  page,
}) => {
  await mount(page, { busyEnterBehavior: "steer" });
  await page.getByRole("button", { name: "Workspace", exact: true }).click();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  for (const key of ["Enter", "Control+Enter", "Meta+Enter", "form"]) {
    await input.fill(`IDLE ${key}`);
    if (key === "form")
      await page.locator("form.composer").dispatchEvent("submit");
    else await input.press(key);
    await expect(input).toHaveValue("");
    const calls = (
      await page.evaluate(() => window.settingsHarness.calls)
    ).filter((c) => c.method === "engineStart");
    expect(calls.at(-1)?.args).toEqual([
      "owned-session",
      `IDLE ${key}`,
      "text",
    ]);
  }
  expect(await page.evaluate(() => window.settingsHarness.unexpected)).toEqual(
    [],
  );
});

test("Web transport forwards explicit discard and the fourth busy argument without altering idle requests", async ({
  page,
}) => {
  await mount(page);
  const captured = await page.evaluate(async () => {
    const requests: Array<{
      url: string;
      method?: string;
      credentials?: string;
      token: string | null;
      body: unknown;
    }> = [];
    const originalFetch = window.fetch;
    const error = {
      ok: false,
      error: { code: "CONTROLLED", message: "No network or inference" },
    };
    window.fetch = async (input, init) => {
      if (input === "/api/bootstrap")
        return Response.json({ csrf: "CONTROLLED-CSRF" });
      requests.push({
        url: String(input),
        method: init?.method,
        credentials: init?.credentials,
        token: new Headers(init?.headers).get("X-Synora-CSRF"),
        body: JSON.parse(String(init?.body)),
      });
      return Response.json(error);
    };
    try {
      const api = window.settingsWebAPI;
      await api.engineStart("owned-session", "queue text", "text", {
        behavior: "queue",
        expectedThreadId: "thread-q",
        expectedTurnId: "turn-q",
      });
      await api.engineStart("owned-session", "steer text", "text", {
        behavior: "steer",
        expectedThreadId: "thread-s",
        expectedTurnId: "turn-s",
      });
      await api.engineStart("owned-session", "idle text", "text");
      const discarded = await api.discardQueuedMessage(
        "owned-session",
        "00000000-0000-4000-8000-000000000001",
      );
      return { requests, discarded };
    } finally {
      window.fetch = originalFetch;
    }
  });
  expect(captured.requests.map((r) => [r.url, r.body])).toEqual([
    [
      "/api/engineStart",
      [
        "owned-session",
        "queue text",
        "text",
        {
          behavior: "queue",
          expectedThreadId: "thread-q",
          expectedTurnId: "turn-q",
        },
      ],
    ],
    [
      "/api/engineStart",
      [
        "owned-session",
        "steer text",
        "text",
        {
          behavior: "steer",
          expectedThreadId: "thread-s",
          expectedTurnId: "turn-s",
        },
      ],
    ],
    ["/api/engineStart", ["owned-session", "idle text", "text"]],
    [
      "/api/discardQueuedMessage",
      ["owned-session", "00000000-0000-4000-8000-000000000001"],
    ],
  ]);
  for (const request of captured.requests) {
    expect(request.method).toBe("POST");
    expect(request.credentials).toBe("same-origin");
    expect(request.token).toBe("CONTROLLED-CSRF");
  }
  expect(captured.discarded).toEqual({
    ok: false,
    error: { code: "CONTROLLED", message: "No network or inference" },
  });
});
