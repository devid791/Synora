import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import { emptyEngine } from "../src/renderer/engine-state";
import type { EngineSnapshot } from "../src/shared/contracts";
let script: string;
test("App Server healthy state stays in footer; genuine transitions keep notices", async ({
  page,
}) => {
  await load(page);
  const notice = page.getByRole("status", {
    name: "App Server connection",
    exact: true,
  });
  const footer = page.locator("footer .app-server-status");
  const update = async (snapshot: EngineSnapshot) =>
    page.evaluate(
      (json) => (window as any).core(JSON.parse(json)),
      JSON.stringify(snapshot),
    );
  await expect(notice).toHaveCount(0);
  await expect(footer).toHaveAttribute("data-phase", "ready");
  await expect(footer).toHaveAttribute(
    "title",
    "App Server connected · PID 9397. Kept ready between messages.",
  );
  await footer.focus();
  await expect(footer).toBeFocused();
  await update({
    ...emptyEngine,
    connection: "live",
    status: "running",
    appServer: { phase: "ready", attempts: 0, pid: 9397 },
  });
  await expect(notice).toHaveCount(0);
  await expect(footer.locator(".dot")).toHaveCSS(
    "background-color",
    "rgb(113, 214, 163)",
  );
  await update({
    ...emptyEngine,
    appServer: { phase: "starting", attempts: 0 },
  });
  await expect(notice).toContainText("Starting App Server");
  await expect(notice.getByRole("button")).toBeDisabled();
  await update({
    ...emptyEngine,
    appServer: { phase: "reconnecting", attempts: 1 },
  });
  await expect(notice).toContainText("Reconnecting App Server automatically");
  await expect(footer).toHaveAttribute("data-phase", "reconnecting");
  await update({
    ...emptyEngine,
    appServer: { phase: "offline", attempts: 2, message: "CONTROLLED offline" },
  });
  await expect(notice).toContainText("CONTROLLED offline");
  await expect(footer).toHaveAttribute("data-phase", "offline");
  await notice.getByRole("button", { name: "Reconnect" }).click();
  expect(await page.evaluate(() => (window as any).reconnects)).toBe(1);
  // Metadata marked ready alone must not hide a disconnected transport.
  await update({
    ...emptyEngine,
    appServer: { phase: "ready", attempts: 0, pid: 9397 },
  });
  await expect(notice).toBeVisible();
  await update({
    ...emptyEngine,
    connection: "live",
    appServer: { phase: "ready", attempts: 0, pid: 9999 },
  });
  await expect(notice).toHaveCount(0);
  await expect(footer).toHaveAttribute("title", /PID 9999/);
  await page.evaluate(() => (window as any).locale("it"));
  await expect(footer).toHaveText("App Server · Connesso");
  await expect(footer).toHaveAttribute(
    "title",
    /App Server connesso · PID 9999/,
  );
});
async function load(page: Page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({
    content: (await readFile("src/renderer/style.css", "utf8")).replace(
      /^@import.*$/gm,
      "",
    ),
  });
  await page.addScriptTag({ content: script });
}
test.beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["tests/fixtures/composer-ui.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});
for (const width of [390, 1280])
  for (const locale of ["en", "it", "fr", "de", "es", "pt", "nl"]) {
    test(`Composer hover, keyboard, menus and localization ${locale} at ${width}px`, async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.setViewportSize({ width, height: 820 });
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({
        content: (await readFile("src/renderer/style.css", "utf8")).replace(
          /^@import.*$/gm,
          "",
        ),
      });
      await page.addScriptTag({ content: script });
      await page.evaluate((locale) => (window as any).locale(locale), locale);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
      const ring = page.locator(".context-ring");
      await ring.hover();
      const popup = page.getByRole("tooltip");
      await expect(popup).toBeVisible();
      const count = (178000).toLocaleString(locale === "pt" ? "pt-PT" : locale);
      await expect(popup).toContainText(count);
      const box = await popup.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(821);
      await page.keyboard.press("Escape");
      await expect(popup).toHaveCount(0);
      await ring.focus();
      await expect(popup).toBeVisible();
      await page.keyboard.press("Escape");
      await page.locator(".composer-add").click();
      await expect(page.locator(".composer-add-menu")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(".composer-add-menu")).not.toBeVisible();
      const permission = page.locator(".permission-trigger");
      await permission.click();
      const menu = page.getByRole("menu");
      await expect(menu.getByRole("menuitemradio")).toHaveCount(3);
      const menuBox = await menu.boundingBox();
      expect(menuBox!.width).toBeLessThanOrEqual(401);
      expect(menuBox!.height).toBeLessThan(340);
      expect(await menu.evaluate(e => e.scrollHeight - e.clientHeight)).toBe(0);
      expect(menuBox!.x).toBeGreaterThanOrEqual(0);
      expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(width);
      expect(menuBox!.y).toBeGreaterThanOrEqual(0);
      expect(menuBox!.y + menuBox!.height).toBeLessThanOrEqual(821);
      await menu.locator('[data-permission-option="full"]').click();
      await expect(page.getByRole("dialog")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(permission).toHaveAttribute("data-permission", "ask");
      await expect(permission).toBeFocused();
      await permission.click();
      await menu.locator('[data-permission-option="auto-review"]').click();
      await expect(permission).toHaveAttribute(
        "data-permission",
        "auto-review",
      );
      expect(await page.evaluate(() => (window as any).permission)).toBe(
        "auto-review",
      );
      await expect(page.locator("code")).toHaveText(
        "Workspace bash {tool_id:1}",
      );
      await expect(page.getByLabel("Fixture message")).toHaveValue(
        "KEEP_MY_DRAFT",
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
    });
  }

test("Permission menu keyboard, checked state, help and focus return", async ({
  page,
}) => {
  await load(page);
  const trigger = page.locator(".permission-trigger"),
    menu = page.getByRole("menu");
  await trigger.focus();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitemradio", { name: "Ask for approval", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(
    menu.getByRole("menuitemradio", { name: "Approve for me", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("End");
  await expect(
    menu.getByRole("menuitemradio", { name: "Full access", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Home");
  await expect(
    menu.getByRole("menuitem", { name: "Learn more" }),
  ).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(trigger).toHaveAttribute("data-permission", "auto-review");
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await trigger.click();
  await expect(menu.locator('[aria-checked="true"]')).toHaveAttribute(
    "data-permission-option",
    "auto-review",
  );
  await page.keyboard.press("Home");
  await page.keyboard.press("Enter");
  await expect(menu).not.toBeVisible();
  await expect(page.getByRole("dialog")).toContainText(
    "on-request · auto_review · workspace-write",
  );
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.keyboard.press("Tab");
  await expect(menu).not.toBeVisible();
  expect(await page.evaluate(() => (window as any).calls)).toBe(1);
});

test("Full access requires confirmation, retains policy on failure and prevents duplicate changes", async ({
  page,
}, testInfo) => {
  await load(page);
  const trigger = page.locator(".permission-trigger"),
    full = page.locator('[data-permission-option="full"]');
  await trigger.click();
  await full.click();
  await page.getByRole("button", { name: "Keep current permissions" }).click();
  expect(await page.evaluate(() => (window as any).calls ?? 0)).toBe(0);
  await expect(trigger).toHaveAttribute("data-permission", "ask");
  await page.evaluate(() => {
    (window as any).failPermission = true;
  });
  await trigger.click();
  await full.click();
  await page
    .getByRole("button", { name: "Enable full access", exact: true })
    .click();
  await expect(page.getByRole("alert")).toHaveText(
    "CONTROLLED permission failure",
  );
  await expect(trigger).toHaveAttribute("data-permission", "ask");
  await page.evaluate(() => {
    (window as any).failPermission = false;
    (window as any).deferPermission = true;
  });
  await page
    .getByRole("button", { name: "Enable full access", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Enable full access", exact: true }),
  ).toBeDisabled();
  await expect(trigger).toBeDisabled();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeVisible();
  expect(await page.evaluate(() => (window as any).calls)).toBe(2);
  await page.evaluate(() => (window as any).finishPermission());
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(trigger).toHaveAttribute("data-permission", "full");
  await expect(trigger).toHaveCSS("color", "rgb(255, 122, 53)");
  await trigger.click();
  await expect(full).toHaveAttribute("aria-checked", "true");
  await expect(full.locator(".permission-check")).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("permission-menu.png") });
  await page.keyboard.press("Escape");
});

test("Busy and outside click close permission menu without changing policy", async ({
  page,
}) => {
  await load(page);
  const trigger = page.locator(".permission-trigger"),
    menu = page.getByRole("menu");
  await trigger.click();
  await expect(menu).toBeVisible();
  await page.evaluate(() => (window as any).busy(true));
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeDisabled();
  await page.evaluate(() => (window as any).busy(false));
  await trigger.click();
  // The popover intentionally overlays the heading; click actual empty space.
  await page.mouse.click(1100, 780);
  await expect(menu).not.toBeVisible();
  await expect(trigger).toHaveAttribute("data-permission", "ask");
  expect(await page.evaluate(() => (window as any).calls ?? 0)).toBe(0);
});
