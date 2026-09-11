import { expect, type Page, type TestInfo } from "@playwright/test";

/** Shared desktop/web assertions. Screenshots are evidence, not the only oracle. */
export async function qualifyDialogs(
  page: Page,
  info: TestInfo,
  capture = () => page.screenshot(),
) {
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  await nav("Bots");
  const originalCards = await page.locator(".card").allTextContents();
  const opener = page.getByRole("button", { name: "New bot", exact: true });
  await opener.click();
  const dialog = page.getByRole("dialog", { name: "New bot preset" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Bot name")).toBeFocused();
  await page.getByLabel("Bot name").fill("Layout test preset");
  // Tab through the entire dialog twice. Background navigation must stay inert.
  for (let i = 0; i < 26; i++) {
    await page.keyboard.press("Tab");
    expect(
      await dialog.evaluate((d) => d.contains(document.activeElement)),
    ).toBe(true);
  }
  for (let i = 0; i < 26; i++) {
    await page.keyboard.press("Shift+Tab");
    expect(
      await dialog.evaluate((d) => d.contains(document.activeElement)),
    ).toBe(true);
  }
  const controls = dialog.locator("input,textarea,select,button");
  for (const control of await controls.all()) {
    await control.scrollIntoViewIfNeeded();
    expect(
      await control.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return (
          r.width > 0 &&
          r.height > 0 &&
          r.x >= 0 &&
          r.right <= innerWidth + 1 &&
          r.y >= 0 &&
          r.bottom <= innerHeight + 1 &&
          (hit === el || el.contains(hit))
        );
      }),
    ).toBe(true);
  }
  await info.attach(
    `bot-dialog-${await page.evaluate(() => `${innerWidth}x${innerHeight}`)}`,
    {
      body: await capture(),
      contentType: "image/png",
    },
  );
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(opener).toBeFocused();
  // No create on cancel. All three configuration editors must share the same behavior.
  // Built-in bot templates are already present; cancel must preserve the whole
  // original list and must not add the draft preset.
  expect(await page.locator(".card").allTextContents()).toEqual(originalCards);
  await expect(page.locator(".card").filter({ hasText: "Layout test preset" })).toHaveCount(0);
  for (const [section, kind] of [
    ["Models & accounts", "provider"],
    ["Connectors", "connector"],
    ["Plugins & MCP", "mcp"],
  ]) {
    await nav(section);
    const add = page.getByRole("button", {
      name: "Add configuration",
      exact: true,
    });
    await add.click();
    const config = page.getByRole("dialog", { name: `${kind} configuration` });
    await expect(config).toBeVisible();
    await expect(page.getByLabel("Configuration ID")).toBeFocused();
    if (kind === "provider") {
      await page.getByLabel("Provider adapter").selectOption("compatible");
      await page
        .getByText("Capability format example (replace model ID and values)", {
          exact: true,
        })
        .click();
      await page.getByLabel("Model capability overrides").fill("{");
      await expect(config.getByRole("alert")).toBeVisible();
      await page.getByLabel("Model capability overrides").fill("{}");
      await expect(config.getByRole("alert")).toHaveCount(0);
      for (const control of await config
        .locator("input,textarea,select,button,summary")
        .all()) {
        await control.scrollIntoViewIfNeeded();
        expect(
          await control.evaluate((el) => {
            const r = el.getBoundingClientRect(),
              hit = document.elementFromPoint(
                r.x + r.width / 2,
                r.y + r.height / 2,
              );
            return (
              r.x >= 0 &&
              r.right <= innerWidth + 1 &&
              r.y >= 0 &&
              r.bottom <= innerHeight + 1 &&
              (hit === el || el.contains(hit))
            );
          }),
        ).toBe(true);
      }
      expect(
        await config
          .locator(".modal")
          .evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
      ).toBe(true);
      await info.attach(
        `compatible-config-${await page.evaluate(() => innerWidth)}`,
        { body: await capture(), contentType: "image/png" },
      );
    }
    await page.keyboard.press("Escape");
    await expect(config).toHaveCount(0);
    await expect(add).toBeFocused();
  }
}

export async function qualifyLayout(
  page: Page,
  info: TestInfo,
  capture = () => page.screenshot(),
) {
  // Exercise populated history, not only the fresh one-conversation screen.
  for (let n = await page.locator(".history .conversation-open").count(); n < 12; n++)
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
  for (const entry of [
    page.locator(".history .conversation-open").first(),
    page.locator(".history .conversation-open").last(),
    page.locator(".history .conversation-more").first(),
    page.locator(".history .conversation-more").last(),
  ]) {
    await entry.scrollIntoViewIfNeeded();
    await entry.click({ trial: true });
    expect(
      await entry.evaluate((el) => {
        const r = el.getBoundingClientRect(),
          box = el.parentElement!.getBoundingClientRect();
        const hit = document.elementFromPoint(
          r.x + r.width / 2,
          r.y + r.height / 2,
        );
        return (
          r.height >= 24 &&
          box.height >= 24 &&
          r.y >= box.y &&
          r.bottom <= box.bottom + 1 &&
          (hit === el || el.contains(hit))
        );
      }),
    ).toBe(true);
  }
  for (const name of [
    "Workspace",
    "Agents",
    "Bots",
    "Browser",
    "Models & accounts",
    "Connectors",
    "Plugins & MCP",
    "Telemetry & backend",
    "Settings",
  ]) {
    await page.getByRole("button", { name, exact: true }).click();
    await expect(page.locator(".topbar")).toContainText(name);
    const geometry = await page.evaluate(() => {
      const rect = (s: string) => {
        const r = document.querySelector(s)!.getBoundingClientRect();
        return {
          x: r.x,
          y: r.y,
          right: r.right,
          bottom: r.bottom,
          width: r.width,
          height: r.height,
        };
      };
      return {
        width: innerWidth,
        height: innerHeight,
        bodyWidth: document.documentElement.scrollWidth,
        top: rect(".topbar"),
        content: rect(".content"),
        footer: rect("footer"),
        sidebar: rect(".sidebar"),
        sideBottom: rect(".sidebar nav"),
      };
    });
    expect(
      geometry.bodyWidth,
      `${name}: no page-wide horizontal overflow`,
    ).toBeLessThanOrEqual(geometry.width + 1);
    expect(
      geometry.top.bottom,
      `${name}: content below topbar`,
    ).toBeLessThanOrEqual(geometry.content.y + 1);
    expect(
      geometry.content.bottom,
      `${name}: footer below content`,
    ).toBeLessThanOrEqual(geometry.footer.y + 1);
    expect(
      geometry.footer.bottom,
      `${name}: footer not clipped`,
    ).toBeLessThanOrEqual(geometry.height + 1);
    expect(geometry.footer.y).toBeGreaterThanOrEqual(0);
    expect(geometry.content.height).toBeGreaterThan(50);
    expect(
      geometry.sideBottom.bottom,
      `${name}: navigation fits sidebar`,
    ).toBeLessThanOrEqual(geometry.sidebar.bottom + 1);
    for (const selector of [".topbar button", ".status-connection", ".status-activity", ".status-gpu", ".status-details-button"]) {
      for (const control of await page.locator(selector).all()) {
        if (!(await control.isVisible())) continue;
        const r = await control.boundingBox();
        expect(r!.x, `${name}: ${selector} left edge`).toBeGreaterThanOrEqual(
          0,
        );
        expect(
          r!.x + r!.width,
          `${name}: ${selector} right edge`,
        ).toBeLessThanOrEqual(geometry.width + 1);
      }
    }
    await info.attach(`layout-${name}-${geometry.width}x${geometry.height}`, {
      body: await capture(),
      contentType: "image/png",
    });
  }
}
