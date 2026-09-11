import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
let script: string;
test.beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["tests/fixtures/workspace-controls-ui.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
});
async function mount(page: any, width = 1440) {
  await page.setViewportSize({ width, height: 950 });
  await page.route("**/*", (r: any) => r.abort());
  await page.setContent('<div id="root"></div>');
  await page.addStyleTag({
    content: (await readFile("src/renderer/style.css", "utf8")).replace(
      /^@import.*$/gm,
      "",
    ),
  });
  await page.addScriptTag({ content: script });
}
test("Re-selecting the active provider retains its usable catalog", async ({page}) => {
  await mount(page);
  await page.getByRole("button", {name:/Axiom · qwen/}).click();
  const provider=page.getByLabel("Workspace provider",{exact:true});
  const model=page.getByLabel("Workspace model",{exact:true});
  await expect(model).toBeEnabled();
  const id=await provider.inputValue(), selected=await model.inputValue();
  await provider.selectOption(id);
  await expect(model).toBeEnabled();
  await expect(model).toHaveValue(selected);
  await expect(page.getByRole("button",{name:"Use model",exact:true})).toBeEnabled();
});
for (const width of [1440, 390])
  test(`Workspace authentic account catalog and exact model/effort at ${width}px`, async ({
    page,
  }) => {
    await mount(page, width);
    await page.getByRole("button", { name: /Axiom · qwen/ }).click();
    await page
      .getByLabel("Workspace provider", { exact: true })
      .selectOption("@openai-account");
    await expect(
      page.getByLabel("Workspace model", { exact: true }),
    ).toHaveValue("gpt-wire-from-core");
    await page
      .getByLabel("Workspace model reasoning", { exact: true })
      .selectOption("high");
    await page.getByRole("button", { name: "Use model", exact: true }).click();
    expect(await page.evaluate(() => (window as any).applied)).toEqual([
      {
        mode: "live",
        providerId: "synora-openai",
        model: "gpt-wire-from-core",
        reasoningEffort: "high",
      },
    ]);
    await expect(
      page
        .getByRole("region", { name: "Provider directory" })
        .getByRole("button"),
    ).toHaveCount(9);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  });
test("Stream telemetry changes before completion and keeps polling during work", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => (window as any).stream());
  await expect(page.locator(".status-activity")).toContainText("Working");
  await page.getByRole("button", { name: "Telemetry details", exact: true }).click();
  await expect(page.getByLabel("Live session telemetry")).toContainText(
    "Text 27 chars",
  );
  await expect(page.getByLabel("Live session telemetry")).toContainText(
    "First text 0.10s",
  );
  await expect
    .poll(() => page.evaluate(() => (window as any).polls))
    .toBeGreaterThan(1);
  await expect(page.getByLabel("Live session telemetry")).toContainText(
    "Tokens: awaiting Core",
  );
});
test("Catalog errors do not retry forever or select unavailable models", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => ((window as any).fail = true));
  await page.getByRole("button", { name: /Axiom · qwen/ }).click();
  await expect(page.getByRole("alert")).toHaveText("Catalog unavailable");
  await expect(
    page.getByRole("button", { name: "Use model", exact: true }),
  ).toBeDisabled();
  expect(await page.evaluate(() => (window as any).calls)).toEqual([
    "models:axiom",
  ]);
  await page.evaluate(() => ((window as any).fail = false));
  await page.getByRole("button", { name: "Refresh models" }).click();
  await expect(
    page.getByRole("button", { name: "Use model", exact: true }),
  ).toBeEnabled();
});
