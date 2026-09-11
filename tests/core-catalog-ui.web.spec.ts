import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";

for (const width of [1440, 390])
  test(`Catalog UI fixture: late operation publication, cancel, all entries, scope and layouts ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    const externalImageRequests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("must-not-fetch.invalid"))
        externalImageRequests.push(request.url());
    });
    page.on("pageerror", (e) => errors.push(e.message));
    const script = await build({
      entryPoints: ["tests/fixtures/core-catalog-ui.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await page.setViewportSize({ width, height: 960 });
    await page.setContent(
      '<main style="padding:16px;width:100%;max-width:900px"><p>Controlled catalog UI fixture, not a live provider</p><div id="root"></div></main>',
    );
    await page.addStyleTag({
      content: await readFile("src/renderer/style.css", "utf8"),
    });
    await page.addScriptTag({ content: script.outputFiles[0].text });
    const panel = page.locator(".core-catalog");
    const read = panel.getByRole("button", { name: "Read Core catalog" });
    expect(await page.evaluate(() => (window as any).catalog.calls)).toEqual(
      [],
    );
    await read.focus();
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("button", { name: "Cancel catalog read" }),
    ).toBeVisible();
    await expect(panel.getByLabel("Catalog provider")).toBeDisabled();
    await page.getByRole("button", { name: "Toggle fixture view" }).click();
    await page.getByRole("button", { name: "Toggle fixture view" }).click();
    await expect(
      panel.getByRole("button", { name: "Cancel catalog read" }),
    ).toBeVisible();
    await panel.getByRole("button", { name: "Cancel catalog read" }).click();
    await expect(panel).toContainText("Catalog read cancelled");
    await expect(read).toBeEnabled();
    expect(await page.evaluate(() => (window as any).catalog.calls)).toEqual([
      ["read", "fixture-provider", "fixture-workspace", false],
      ["cancel", "fixture-1"],
    ]);
    await read.click();
    await expect(
      panel.getByRole("button", { name: "Cancel catalog read" }),
    ).toBeVisible();
    await page.evaluate(() => (window as any).catalog.finish());
    await expect(panel).toContainText("51 plugins reported by Core");
    const conflicts = panel.getByRole("status", { name: "Catalog identity conflicts", exact: true });
    await expect(conflicts).toContainText("Unaffected entries remain available");
    await conflicts.getByText("Unavailable identities: 2", { exact: true }).click();
    await expect(conflicts).toContainText("conflicting-plugin");
    await expect(conflicts).toContainText("conflicting-app");
    await expect(conflicts.getByRole("button")).toHaveCount(0);
    await expect(panel.getByRole("article").filter({ hasText: "conflicting-plugin" })).toHaveCount(0);
    await expect(panel).toContainText("Account status unavailable");
    await expect(panel.getByRole("alert")).toContainText(
      "Controlled partial account failure",
    );
    await expect(panel.getByRole("article")).toHaveCount(24);
    await panel
      .getByRole("button", { name: "Show more catalog entries" })
      .click();
    await expect(panel.getByRole("article")).toHaveCount(48);
    await panel
      .getByRole("button", { name: "Show more catalog entries" })
      .click();
    await expect(panel.getByRole("article")).toHaveCount(51);
    await expect(
      panel.getByRole("button", { name: "Show more catalog entries" }),
    ).toHaveCount(0);
    await panel.getByLabel("Filter Core catalog").fill("fixture-50");
    await expect(panel.getByRole("article")).toHaveCount(1);
    await panel.getByText("Original plugin metadata", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(panel.locator("details pre")).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/core-catalog/fixture-${width}.png`,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Switch fixture catalog" }).click();
    await expect(panel).toContainText("Connector UI fixture");
    await expect(panel).toContainText("Original runtime-only connector");
    await expect(panel).toContainText("Catalog metadata unavailable");
    await expect(panel).toContainText("2 connectors reported by Core");
    await expect(panel).toContainText("Committed Core runtime: Not callable");
    await expect(panel).not.toContainText("Callable in this provider snapshot");
    const icon = panel.getByRole("img", {
      name: "Connector UI fixture original icon",
      exact: true,
    });
    await panel
      .getByRole("heading", { name: "Connector UI fixture" })
      .scrollIntoViewIfNeeded();
    await expect(icon).toBeVisible();
    await expect
      .poll(() =>
        icon.evaluate(
          (e: HTMLImageElement) => e.complete && e.naturalWidth === 48,
        ),
      )
      .toBe(true);
    await expect(icon).toHaveAttribute(
      "data-icon-field",
      "iconDarkAssets.256_square",
    );
    expect(externalImageRequests).toEqual([]);
    await page.screenshot({
      path: `test-results/core-catalog/connector-icons-${width}.png`,
      fullPage: true,
    });
    expect(errors).toEqual([]);
  });
