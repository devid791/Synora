import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCatalogFixture } from "./fixtures/core-catalog";
import { startWebService } from "../src/web/server";
import { oauthMcpServer } from "./fixtures/oauth-mcp-server";
import type { Result } from "../src/shared/contracts";
const value = <T>(v: Result<T>) => {
  if (!v.ok) throw Error(v.error.message);
  return v.value;
};
test("Original plugin through shared web: review/confirmation/install, reload/cold persistence, stale config refusal, removal and responsive modal", async ({
  page,
}) => {
  const fixture = await ownedCatalogFixture();
  const old = process.env.SYNORA_CODEX_BINARY;
  process.env.SYNORA_CODEX_BINARY = fixture.core;
  const options = {
    storePath: join(fixture.directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  let server = await startWebService(options);
  server.service.store.preferences({ pluginCatalogAutomatic: false, botCatalogAutomatic: false });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Original Core plugin catalog",
  });
  const dialog = page.getByRole("dialog", { name: "Core plugin management" });
  const read = async () => {
    if (!(await panel.isVisible()))
      await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    await panel.getByLabel("Catalog provider").selectOption("openai");
    await panel.getByRole("button", { name: "Read Core catalog" }).click();
    await expect(
      panel.getByRole("heading", { name: "Synora Catalog Proof" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Read Core catalog" }),
    ).toBeEnabled();
  };
  const inspect = async () => {
    await panel
      .getByRole("button", { name: "Inspect plugin capabilities" })
      .focus();
    await page.keyboard.press("Enter");
    await expect(dialog.getByRole("status")).toContainText(
      "Original plugin details loaded.",
    );
    await expect(dialog).toContainText("synora-catalog-proof:catalog-proof");
  };
  try {
    await page.goto(server.url);
    await nav("Add workspace");
    await page.getByLabel("Service folder").fill(fixture.workspace);
    await nav("Open folder");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("openai");
    await page.getByLabel("Configuration name").fill("Owned OpenAI");
    await page.getByLabel("Provider adapter").selectOption("openai");
    await page.getByLabel("Enable configuration").check();
    // Models starts an owned metadata-only account read. Configuration changes
    // must wait for its cleanup instead of racing the authorization guard.
    await expect
      .poll(async () => value(await server.service.api.coreAccountStatus()).busy,
        { timeout: 35000 })
      .toBe(false);
    await nav("Save configuration");
    await expect(page.getByRole("dialog", {
      name: "provider configuration", exact: true,
    })).toBeHidden();
    await nav("Plugins & MCP");
    await read();
    await inspect();
    await expect(
      dialog.getByRole("button", { name: "Install plugin", exact: true }),
    ).toBeDisabled();
    const original = value(await server.service.api.corePluginStatus())!;
    expect(
      (
        await server.service.invoke("corePluginChange", [
          original.id,
          "install",
          false,
        ])
      ).ok,
    ).toBe(false);
    expect(
      (
        await server.service.invoke("corePluginInspect", [
          "stale",
          "personal",
          original.target.pluginId,
        ])
      ).ok,
    ).toBe(false);
    expect(value(await server.service.api.corePluginStatus())!.id).toBe(
      original.id,
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const confirm = dialog.getByRole("checkbox");
      await confirm.scrollIntoViewIfNeeded();
      await confirm.focus();
      for (let i = 0; i < 8; i++) {
        await page.keyboard.press("Tab");
        expect(
          await page.evaluate(
            () => !!document.activeElement?.closest("dialog[open]"),
          ),
        ).toBe(true);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      for (const control of await dialog.locator("button,input,pre").all()) {
        if (!(await control.isVisible())) continue;
        const box = await control.boundingBox(),
          bounds = await dialog.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
        expect(box!.x + box!.width).toBeLessThanOrEqual(
          bounds!.x + bounds!.width + 1,
        );
      }
      await confirm.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/core-plugin/plugin-${width}.png`,
        fullPage: true,
      });
    }
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Inspect plugin capabilities" }),
    ).toBeFocused();
    await inspect();
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Install plugin", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText(
      "Plugin installed and enabled; state verified by Core.",
    );
    const installed = value(await server.service.api.corePluginStatus())!;
    expect(installed.mutationSent).toBe(true);
    expect(value(await server.service.api.coreCatalogStatus())).toBeNull();
    await page.reload();
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    await nav("View last plugin operation");
    await expect(dialog).toContainText(
      "Plugin installed and enabled; state verified by Core.",
    );
    await nav("Close plugin panel");
    await read();
    await expect(panel).toContainText("Installed · Enabled · AVAILABLE");
    await panel
      .getByRole("heading", { name: "Synora Catalog Proof" })
      .scrollIntoViewIfNeeded();
    const installedIcon = panel.getByRole("img", {
      name: "Synora Catalog Proof original icon",
      exact: true,
    });
    await expect(installedIcon).toBeVisible();
    await expect
      .poll(() =>
        installedIcon.evaluate(
          (e: HTMLImageElement) => e.complete && e.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await page.goto("about:blank");
    await server.close();
    server = await startWebService(options);
    await page.goto(server.url);
    await read();
    await expect(panel).toContainText("Installed · Enabled · AVAILABLE");
    await inspect();
    const review = value(await server.service.api.corePluginStatus())!;
    const provider = server.service.store
      .read()
      .integrations.find((p) => p.id === "openai")!;
    value(
      await server.service.api.integrationSave(
        { ...provider, name: "Changed provider identity" },
        provider.id,
      ),
    );
    const mismatch = await server.service.api.corePluginChange(
      review.id,
      "uninstall",
      true,
    );
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok)
      expect(mismatch.error.message).toContain("changed after plugin review");
    expect(value(await server.service.api.corePluginStatus())!.id).toBe(
      review.id,
    );
    await nav("Close plugin panel");
    await read();
    await inspect();
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Remove plugin", exact: true })
      .click();
    await expect(dialog.getByRole("status")).toContainText(
      "Plugin removed from this Synora profile; state verified by Core.",
    );
    const removed = value(await server.service.api.corePluginStatus());
    expect(
      await readFile(join(fixture.plugin, ".codex-plugin/plugin.json"), "utf8"),
    ).toBe(JSON.stringify(fixture.manifest, null, 2));
    expect(server.service.engine.snapshot().items).toEqual([]);
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/core-plugin-web.json",
      JSON.stringify(
        {
          passed: true,
          at: new Date().toISOString(),
          fixture,
          installed,
          removed,
          errors,
          scope:
            "Real shared web and original Core installation. No model or public account.",
        },
        null,
        2,
      ),
    );
  } finally {
    await page.goto("about:blank").catch(() => {});
    await server.close();
    if (old === undefined) delete process.env.SYNORA_CODEX_BINARY;
    else process.env.SYNORA_CODEX_BINARY = old;
  }
});

test("Plugin OAuth uses shared named API: actual Core PKCE, pending reload, cancel, denial, identity guards and no automatic authorization", async ({
  page,
}) => {
  const oauth = await oauthMcpServer(),
    fixture = await ownedCatalogFixture(oauth.endpoint);
  const old = process.env.SYNORA_CODEX_BINARY;
  process.env.SYNORA_CODEX_BINARY = fixture.core;
  const server = await startWebService({
    storePath: join(fixture.directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Core plugin management" }),
    auth = dialog.getByRole("region", { name: "Plugin MCP browser sign-in" });
  const awaitIdle = async () =>
    expect
      .poll(
        async () =>
          value(await server.service.api.mcpAuthorizationStatus())?.busy,
      )
      .toBe(false);
  try {
    value(await server.service.api.chooseWorkspace(fixture.workspace));
    value(
      await server.service.api.integrationSave({
        id: "openai",
        name: "Owned OpenAI",
        kind: "provider",
        providerType: "openai",
        endpoint: "https://api.openai.com/v1",
        auth: "core-account",
        enabled: true,
        tools: [],
      }),
    );
    await page.goto(server.url);
    await nav("Plugins & MCP");
    const catalog = page.getByRole("region", {
      name: "Original Core plugin catalog",
    });
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    await catalog.getByLabel("Catalog provider").selectOption("openai");
    await nav("Read Core catalog");
    await expect(
      catalog.getByRole("button", { name: "Inspect plugin capabilities" }),
    ).toBeEnabled();
    await nav("Inspect plugin capabilities");
    await expect(dialog.getByRole("checkbox")).toBeEnabled();
    await expect(
      auth.getByRole("button", { name: "Sign in to proof", exact: true }),
    ).toBeDisabled();
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Install plugin", exact: true })
      .click();
    await expect(dialog).toContainText(
      "Plugin installed and enabled; state verified by Core.",
    );
    console.log("PLUGIN_UI installed");
    expect(oauth.counts()).toEqual({ grants: 0, refreshes: 0, pkce: 0 });
    const installed = value(await server.service.api.corePluginStatus())!;
    expect(
      (
        await server.service.api.corePluginAuthorize(
          installed.id,
          "invented-server",
        )
      ).ok,
    ).toBe(false);
    await auth
      .getByRole("button", { name: "Sign in to proof", exact: true })
      .click();
    await expect(
      auth.getByRole("link", { name: "Open plugin authorization page" }),
    ).toBeVisible();
    console.log("PLUGIN_UI authorization URL ready");
    const initial = value(await server.service.api.mcpAuthorizationStatus())!;
    expect(initial.pluginId).toBe("synora-catalog-proof@personal");
    expect(initial.serverName).toBe("proof");
    expect(
      (
        await server.service.api.corePluginChange(
          installed.id,
          "uninstall",
          true,
        )
      ).ok,
    ).toBe(false);
    await page.reload();
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    await nav("View last plugin operation");
    await expect(
      auth.getByRole("link", { name: "Open plugin authorization page" }),
    ).toBeVisible();
    expect(value(await server.service.api.mcpAuthorizationStatus())!.id).toBe(
      initial.id,
    );
    await nav("Close plugin panel");
    await expect(
      catalog.getByRole("button", { name: "Read Core catalog" }),
    ).toBeDisabled();
    await nav("View last plugin operation");
    await expect(
      auth.getByRole("link", { name: "Open plugin authorization page" }),
    ).toBeVisible();
    const popupPromise = page.waitForEvent("popup");
    await auth
      .getByRole("link", { name: "Open plugin authorization page" })
      .click();
    const popup = await popupPromise;
    await popup.waitForLoadState();
    await popup.close();
    console.log("PLUGIN_UI popup completed");
    await expect(auth).toContainText("Plugin browser sign-in completed");
    await awaitIdle();
    const completed = value(await server.service.api.mcpAuthorizationStatus());
    console.log("PLUGIN_UI authorized and idle");
    expect(oauth.counts().pkce).toBe(1);
    expect(oauth.counts().grants).toBe(1);
    await page.setViewportSize({ width: 390, height: 900 });
    await auth
      .getByRole("button", { name: "Sign in to proof", exact: true })
      .click();
    await expect(
      auth.getByRole("link", { name: "Open plugin authorization page" }),
    ).toBeVisible();
    await auth.getByRole("button", { name: "Cancel plugin sign-in" }).click();
    await expect(auth).toContainText("cancelled");
    await awaitIdle();
    console.log("PLUGIN_UI cancelled and idle");
    oauth.deny(true);
    await auth
      .getByRole("button", { name: "Sign in to proof", exact: true })
      .click();
    await expect(
      auth.getByRole("link", { name: "Open plugin authorization page" }),
    ).toBeVisible();
    const deniedPopup = page.waitForEvent("popup");
    await auth
      .getByRole("link", { name: "Open plugin authorization page" })
      .click();
    const denial = await deniedPopup;
    await denial.waitForLoadState();
    await denial.close();
    await expect(auth).toContainText("Core reported unsuccessful sign-in");
    await awaitIdle();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await auth.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: "test-results/core-plugin/oauth-390.png",
      fullPage: true,
    });
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Remove plugin", exact: true })
      .click();
    await expect(dialog).toContainText(
      "Plugin removed from this Synora profile",
    );
    expect(errors).toEqual([]);
    expect(oauth.failures).toEqual([]);
    expect(server.service.engine.snapshot().items).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/core-plugin-oauth-web.json",
      JSON.stringify(
        {
          passed: true,
          at: new Date().toISOString(),
          fixture,
          completed,
          finalAuth: value(await server.service.api.mcpAuthorizationStatus()),
          counts: oauth.counts(),
          network: oauth.events,
          errors,
          scope:
            "Original Core plugin install/OAuth and shared web; controlled OAuth account, no inference",
        },
        null,
        2,
      ),
    );
  } finally {
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/core-plugin-oauth-web-last-state.json",
      JSON.stringify(
        {
          at: new Date().toISOString(),
          auth: await server.service.api.mcpAuthorizationStatus(),
          plugin: await server.service.api.corePluginStatus(),
          network: oauth.events,
          counts: oauth.counts(),
          errors,
        },
        null,
        2,
      ),
    );
    await page.goto("about:blank").catch(() => {});
    try {
      await server.close();
    } finally {
      await oauth.close();
    }
    if (old === undefined) delete process.env.SYNORA_CODEX_BINARY;
    else process.env.SYNORA_CODEX_BINARY = old;
  }
});
