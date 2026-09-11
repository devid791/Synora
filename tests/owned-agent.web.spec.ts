import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
test("Render the same actual recovered child and measurements; no new agent or inference", async ({
  page,
}) => {
  const receipt = JSON.parse(
    await readFile("out/live-evidence/owned-agent-recovery.json", "utf8"),
  );
  expect(receipt.passed).toBe(true);
  const agent = receipt.final.agents[0];
  expect(agent.name).toBe("Darwin");
  expect(agent.backendRequests).toHaveLength(2);
  const script = await build({
    entryPoints: ["tests/fixtures/agent-ui.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    define: { "process.env.NODE_ENV": '"production"' },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  // Replay the original observation into the real shared component, not a new model request.
  await page.setContent(
    '<main style="padding:16px;width:100%;max-width:1100px"><p>Actual saved agent record — read-only UI recovery</p><div id="root"></div></main>',
  );
  await page.evaluate((a) => {
    window.ownedAgent = a;
  }, agent);
  await page.addStyleTag({
    content: await readFile("src/renderer/style.css", "utf8"),
  });
  await page.addScriptTag({ content: script.outputFiles[0].text });
  const card = page.getByRole("article", { name: "Agent Darwin" });
  await expect(card).toContainText("Live · completed");
  await expect(card).toContainText("Closed");
  await expect(card).toContainText(agent.result);
  await card.getByText("Identity and timing", { exact: true }).click();
  await expect(card).toContainText(agent.coreSessionId);
  await card.getByText("Tool activity", { exact: true }).click();
  await expect(card.locator(".tool-call")).toContainText(
    "cat agent-readonly.txt",
  );
  await expect(card.locator(".tool-call")).toContainText("Exit: 0");
  for (const m of agent.backendRequests) {
    const details = card
      .locator(".axiom-telemetry details")
      .filter({ hasText: m.responseId });
    await details.locator("summary").click();
    await expect(details).toContainText(m.sessionId);
    await expect(details).toContainText(m.turnId);
  }
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await card
      .getByRole("button", { name: "Open parent conversation" })
      .click();
    expect(await page.evaluate(() => window.parentOpened)).toBe(agent.parentId);
    await page.screenshot({
      path: `test-results/owned-agent/agent-${width}.png`,
      fullPage: true,
    });
  }
  expect(errors).toEqual([]);
});
