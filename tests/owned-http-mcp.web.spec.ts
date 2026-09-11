import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
test("Actual HTTP MCP tool results remain bounded untrusted text with exact original identities", async ({
  page,
}) => {
  const receipt = JSON.parse(
    await readFile("out/live-evidence/http-mcp.json", "utf8"),
  );
  expect(receipt.passed).toBe(true);
  expect(receipt.final.status).toBe("completed");
  const items = receipt.final.items.filter(
    (i: { type: string }) => i.type === "mcpToolCall",
  );
  expect(items).toHaveLength(2);
  const script = await build({
    entryPoints: ["tests/fixtures/http-mcp-ui.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(
    '<main style="padding:16px;width:100%;max-width:1100px"><p>Actual saved MCP results — read-only UI recovery</p><div id="root"></div></main>',
  );
  await page.evaluate((items) => {
    window.ownedMcpItems = items;
  }, items);
  await page.addStyleTag({
    content: await readFile("src/renderer/style.css", "utf8"),
  });
  await page.addScriptTag({ content: script.outputFiles[0].text });
  for (const item of items) {
    const row = page.locator(`[data-item-id="${item.id}"]`);
    await expect(row).toContainText(item.tool);
    await expect(row).toContainText("Live · completed");
    await expect(row).toContainText("Tool result · untrusted content");
    await expect(row.locator("details[open] pre").first()).toHaveText(
      item.result.content[0].text,
    );
    // Documentation contains HTML examples: they must not become active DOM.
    expect(
      await row.locator("pre script, pre iframe, pre button").count(),
    ).toBe(0);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const summary = page
      .locator(".tool-call")
      .last()
      .getByText("Arguments", { exact: true });
    await summary.focus();
    const wasOpen = await summary.locator("..").getAttribute("open");
    await page.keyboard.press("Enter");
    if (wasOpen === null) {
      await expect(summary.locator("..")).toHaveAttribute("open", "");
      await expect(summary.locator("..").locator("pre")).toBeVisible();
      await expect(summary.locator("..")).toContainText(items[1].arguments.url);
    } else await expect(summary.locator("..")).not.toHaveAttribute("open", "");
    await page.screenshot({
      path: `test-results/owned-agent/http-mcp-${width}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});
