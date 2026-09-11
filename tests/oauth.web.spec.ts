import { test, expect } from "@playwright/test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWebService } from "../src/web/server";
import { oauthMcpServer } from "./fixtures/oauth-mcp-server";
import { managedCore } from "../src/engine/core-runtime";

test("Shared web UI performs actual Core OAuth, restores pending flow, cancels and never calls Axiom", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-oauth-ui-"));
  const fixture = await oauthMcpServer();
  const executable = await managedCore(join(directory, "core-payload"));
  const previousBinary = process.env.SYNORA_CODEX_BINARY;
  process.env.SYNORA_CODEX_BINARY = executable;
  const server = await startWebService({
    storePath: join(directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  try {
    await page.goto(server.url);
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("oauth-namespace");
    await page.getByLabel("Configuration name").fill("Controlled namespace");
    // This fixture deliberately cannot serve inference or a model catalog.
    await page
      .getByLabel("Configuration endpoint")
      .fill(`${new URL(fixture.endpoint).origin}/codex/v1`);
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Plugins & MCP");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("oauth-server");
    await page.getByLabel("Configuration name").fill("Controlled OAuth MCP");
    await page.getByLabel("Integration executor").selectOption("http-mcp");
    await page.getByLabel("Configuration endpoint").fill(fixture.endpoint);
    await page.getByLabel("Authentication method").selectOption("oauth");
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    const auth = page.getByRole("article", { name: "MCP browser sign-in" });
    await auth
      .getByRole("combobox", { name: "OAuth MCP integration" })
      .selectOption("oauth-server");
    await auth
      .getByRole("combobox", { name: "OAuth provider namespace" })
      .selectOption("oauth-namespace");
    await auth.getByRole("button", { name: "Start browser sign-in" }).click();
    await expect(
      auth.getByRole("link", { name: "Open authorization page" }),
    ).toBeVisible();
    expect(fixture.counts().grants).toBe(0);
    const flow = await server.service.api.mcpAuthorizationStatus();
    expect(flow.ok).toBe(true);
    if (!flow.ok || !flow.value) throw new Error("No pending flow");
    const identity = flow.value.id;
    for (const [operation, args] of [
      ["integrationDelete", ["oauth-server"]],
      ["engineStart", ["missing-conversation", "Must not run", "text"]],
      [
        "engineConfigure",
        [{ mode: "simulated", providerId: null, model: null }],
      ],
    ] as const) {
      const result = await server.service.invoke(operation, args);
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.message).toContain("pending browser sign-in");
    }
    await page.reload();
    await expect(
      auth.getByRole("link", { name: "Open authorization page" }),
    ).toBeVisible();
    const resumed = await server.service.api.mcpAuthorizationStatus();
    expect(resumed.ok && resumed.value?.id).toBe(identity);
    const popup = page.waitForEvent("popup");
    await auth.getByRole("link", { name: "Open authorization page" }).click();
    const providerPage = await popup;
    await expect(auth).toContainText("Browser sign-in completed");
    expect(await providerPage.evaluate(() => window.opener === null)).toBe(
      true,
    );
    await providerPage.close();
    const integrationCard = page
      .locator("article.card")
      .filter({
        has: page.locator("strong", { hasText: "Controlled OAuth MCP" }),
      });
    await expect(integrationCard).toContainText("0 mounted tools");
    await expect(integrationCard).toContainText("Not connected");
    expect(fixture.counts()).toEqual({ grants: 1, refreshes: 0, pkce: 1 });
    const config = JSON.stringify(server.service.store.read());
    expect(config).not.toContain("authorizationUrl");
    expect(config).not.toContain("access_token");
    // Retrying then cancelling closes the owned callback; an old link cannot grant.
    await auth.getByRole("button", { name: "Start browser sign-in" }).click();
    await expect(
      auth.getByRole("link", { name: "Open authorization page" }),
    ).toBeVisible();
    await auth.getByRole("button", { name: "Cancel sign-in" }).click();
    await expect(auth).toContainText("cancelled");
    await expect(
      auth.getByRole("link", { name: "Open authorization page" }),
    ).toHaveCount(0);
    expect(fixture.counts().grants).toBe(1);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await auth.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/oauth-web/actual-oauth-${width}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
    expect(fixture.failures).toEqual([]);
    expect(fixture.events.some((e) => e.path.includes("/codex/v1"))).toBe(
      false,
    );
    await writeFile(
      "out/live-evidence/mcp-oauth-web.json",
      JSON.stringify(
        {
          passed: true,
          directory,
          originalIdentity: identity,
          inferenceRequests: 0,
          counts: fixture.counts(),
          errors,
          events: fixture.events,
          coreCredentialFilePresent: !!(
            await readFile(
              join(directory, "app-server/oauth-namespace/.credentials.json"),
            )
          ).length,
        },
        null,
        2,
      ),
    );
  } finally {
    await page.goto("about:blank");
    await server.close();
    await fixture.close();
    if (previousBinary === undefined) delete process.env.SYNORA_CODEX_BINARY;
    else process.env.SYNORA_CODEX_BINARY = previousBinary;
  }
});
