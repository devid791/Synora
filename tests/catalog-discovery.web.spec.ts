import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let script: string;
test.beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["tests/fixtures/catalog-discovery-ui.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});
for (const width of [1440, 390])
  test(`Public plugin auto-discovery before sign-in at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/*", (r) => r.abort());
    await page.setContent('<div id="root"></div>');
    await page.addStyleTag({
      content: (await readFile("src/renderer/style.css", "utf8")).replace(
        /^@import.*$/gm,
        "",
      ),
    });
    await page.addScriptTag({ content: script });
    await expect(
      page.getByRole("heading", { name: "Gmail", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".catalog-connection-required")).toContainText(
      "Connection required",
    );
    await expect(
      page.getByRole("button", { name: "Inspect plugin capabilities" }),
    ).toBeEnabled();
    const calls = await page.evaluate(() => (window as any).catalogCalls);
    expect(
      calls.filter((c: any) => c.method === "coreCatalogRead"),
    ).toHaveLength(1);
    expect(
      calls.some((c: any) => /Login|Install|engine|Change/.test(c.method)),
    ).toBe(false);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole("button", { name: "Read Core catalog" }).click();
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as any).catalogCalls.filter(
              (c: any) => c.method === "coreCatalogRead",
            ).length,
        ),
      )
      .toBe(2);
  });
test("Automatic discovery failure is visible and does not loop; manual retry recovers", async ({
  page,
}) => {
  await page.setContent('<div id="root"></div>');
  await page.evaluate(() => {
    (window as any).catalogFail = true;
  });
  await page.addScriptTag({ content: script });
  await expect(page.getByRole("alert")).toContainText(
    "Directory temporarily unavailable",
  );
  expect(
    await page.evaluate(
      () =>
        (window as any).catalogCalls.filter(
          (c: any) => c.method === "coreCatalogRead",
        ).length,
    ),
  ).toBe(1);
  await page.evaluate(() => {
    (window as any).catalogFail = false;
  });
  await page.getByRole("button", { name: "Read Core catalog" }).click();
  await expect(
    page.getByRole("heading", { name: "Gmail", exact: true }),
  ).toBeVisible();
});
