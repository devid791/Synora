import { test, expect } from "@playwright/test";
import { writeFile, readFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { startWebService } from "../src/web/server";
import { ownedCatalogFixture } from "./fixtures/core-catalog";
import type { Result } from "../src/shared/contracts";
import { createHash } from "node:crypto";
const value = <T>(r: Result<T>): T => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};

test("Original Core plugin catalog through real shared UI: identity, reload, malformed marketplace and retry, no inference", async ({
  page,
}) => {
  const fixture = await ownedCatalogFixture();
  const old = process.env.SYNORA_CODEX_BINARY;
  process.env.SYNORA_CODEX_BINARY = fixture.core;
  const options = {
    storePath: join(fixture.directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  const server = await startWebService(options);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const panel = page.getByRole("region", {
    name: "Original Core plugin catalog",
  });
  try {
    await page.goto(server.url);
    server.service.store.preferences({ pluginCatalogAutomatic: false, botCatalogAutomatic: false });
    await nav("Add workspace");
    await page.getByLabel("Service folder").fill(fixture.workspace);
    await nav("Open folder");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("openai");
    await page.getByLabel("Configuration name").fill("Owned OpenAI");
    await page.getByLabel("Provider adapter").selectOption("openai");
    await page.getByLabel("Enable configuration").check();
    // The automatic account metadata read must finish before configuration is changed.
    await expect
      .poll(async () => value(await server.service.api.coreAccountStatus()).busy,
        { timeout: 35000 })
      .toBe(false);
    await nav("Save configuration");
    await expect(page.getByRole("dialog", {
      name: "provider configuration", exact: true,
    })).toBeHidden();
    await nav("Plugins & MCP");
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    expect(value(await server.service.api.coreCatalogStatus())).toBeNull();
    await panel.getByLabel("Catalog provider").selectOption("openai");
    await panel.getByRole("button", { name: "Read Core catalog" }).focus();
    await page.keyboard.press("Enter");
    await expect(
      panel.getByRole("heading", { name: "Synora Catalog Proof" }),
    ).toBeVisible();
    await expect(panel).toContainText("Not installed · Disabled · AVAILABLE");
    await expect(panel).toContainText("Local version: 1.0.0");
    await expect(panel).toContainText(
      "Not the active conversation's mounted-tool inventory",
    );
    await expect(
      panel.getByRole("button", { name: "Read Core catalog" }),
    ).toBeEnabled();
    const first = value(await server.service.api.coreCatalogStatus())!;
    expect(first.errors).toEqual([]);
    expect(first.busy).toBe(false);
    expect(first.plugins?.marketplaces[0].plugins[0].id).toBe(
      "synora-catalog-proof@personal",
    );
    expect(first.installedApps?.apps).toEqual([]);
    const icon = panel.getByRole("img", {
      name: "Synora Catalog Proof original icon",
      exact: true,
    });
    await panel
      .getByRole("heading", { name: "Synora Catalog Proof" })
      .scrollIntoViewIfNeeded();
    await expect(icon).toBeVisible();
    // Plugin logos follow the resolved application theme, not a fixed dark hint.
    for (const theme of ["light", "dark"] as const) {
      value(await server.service.api.preferences({ theme }));
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(icon).toHaveAttribute(
        "data-icon-field", theme === "dark" ? "logoDark" : "logo",
      );
    }
    const originalBytes = await readFile(
      join(fixture.plugin, "assets/logo.svg"),
    );
    await expect(icon).toHaveAttribute(
      "data-icon-sha256",
      createHash("sha256").update(originalBytes).digest("hex"),
    );
    expect(
      await icon.evaluate(
        (e: HTMLImageElement) => e.complete && e.naturalWidth > 0,
      ),
    ).toBe(true);
    expect(
      (
        await server.service.invoke("coreCatalogIcon", [
          {
            catalogId: first.id,
            kind: "plugin",
            id: "synora-catalog-proof@personal",
            marketplace: "personal",
            theme: "dark",
            path: "/etc/passwd",
          },
        ])
      ).ok,
    ).toBe(false);
    // A corrupt original image must show a recoverable failure, not a broken
    // element or an invented brand. Retry must bypass a cached decode failure.
    await writeFile(
      join(fixture.plugin, "assets/logo.svg"),
      '<svg xmlns="http://www.w3.org/2000/svg"><',
    );
    await panel.getByRole("button", { name: "Read Core catalog" }).click();
    const retryIcon = panel.getByRole("button", {
      name: "Retry icon for Synora Catalog Proof",
    });
    await panel
      .getByRole("heading", { name: "Synora Catalog Proof" })
      .scrollIntoViewIfNeeded();
    await expect(retryIcon).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Read Core catalog" }),
    ).toBeEnabled();
    await expect(
      panel.getByRole("img", {
        name: "Synora Catalog Proof: Original icon could not be decoded.",
        exact: true,
      }),
    ).toBeVisible();
    await writeFile(join(fixture.plugin, "assets/logo.svg"), originalBytes);
    await retryIcon.focus();
    await page.keyboard.press("Enter");
    await expect(icon).toBeVisible();
    await expect
      .poll(() =>
        icon.evaluate(
          (e: HTMLImageElement) => e.complete && e.naturalWidth > 0,
        ),
      )
      .toBe(true);
    const refreshed = value(await server.service.api.coreCatalogStatus())!;
    await page.reload();
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    await expect(panel.getByLabel("Catalog provider")).toHaveValue("openai");
    await expect(
      panel.getByRole("heading", { name: "Synora Catalog Proof" }),
    ).toBeVisible();
    expect(value(await server.service.api.coreCatalogStatus())?.id).toBe(
      refreshed.id,
    );
    await panel.getByLabel("Filter Core catalog").fill("does-not-exist");
    await expect(panel.getByRole("article")).toHaveCount(0);
    await panel.getByLabel("Filter Core catalog").fill("Proof");
    await expect(panel.getByRole("article")).toHaveCount(1);
    await panel.getByText("Original plugin metadata", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(panel.locator("details pre")).toContainText(
      '"authPolicy": "ON_INSTALL"',
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await panel.getByLabel("Catalog provider").scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const bounds = await panel.boundingBox();
      for (const selector of [
        "select",
        'input:not([type="checkbox"])',
        "pre",
      ]) {
        for (const element of await panel.locator(selector).all()) {
          const box = await element.boundingBox();
          if (!box) continue;
          expect(box.x).toBeGreaterThanOrEqual(bounds!.x);
          expect(box.x + box.width).toBeLessThanOrEqual(
            bounds!.x + bounds!.width + 1,
          );
        }
      }
      await page.screenshot({
        path: `test-results/core-catalog/catalog-${width}.png`,
        fullPage: true,
      });
      await panel
        .getByRole("heading", { name: "Synora Catalog Proof" })
        .scrollIntoViewIfNeeded();
      await expect(icon).toBeVisible();
      await page.screenshot({
        path: `test-results/core-catalog/icon-${width}.png`,
        fullPage: true,
      });
    }
    await nav("Connectors");
    const connectors = page.getByRole("region", {
      name: "Original Core connector catalog",
    });
    await expect(connectors).toContainText("0 connectors reported by Core");
    expect(value(await server.service.api.coreCatalogStatus())?.id).toBe(
      refreshed.id,
    );
    await nav("Plugins & MCP");
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    await writeFile(
      fixture.marketplace,
      '{"name":"personal","plugins":"malformed"}',
    );
    await panel.getByRole("button", { name: "Read Core catalog" }).click();
    await expect
      .poll(
        async () =>
          value(await server.service.api.coreCatalogStatus())?.plugins
            ?.marketplaceLoadErrors.length,
      )
      .toBeGreaterThan(0);
    await expect(panel.getByRole("alert")).toContainText("marketplace.json");
    await expect(
      panel.getByRole("button", { name: "Read Core catalog" }),
    ).toBeEnabled();
    const malformed = value(await server.service.api.coreCatalogStatus())!;
    expect(malformed.plugins?.marketplaces.flatMap((m) => m.plugins)).toEqual(
      [],
    );
    await writeFile(fixture.marketplace, JSON.stringify(fixture.catalog));
    await panel.getByRole("button", { name: "Read Core catalog" }).click();
    await expect(
      panel.getByRole("heading", { name: "Synora Catalog Proof" }),
    ).toBeVisible();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(
      panel.getByRole("button", { name: "Read Core catalog" }),
    ).toBeEnabled();
    expect(server.service.engine.snapshot().items).toEqual([]);
    expect(
      server.service.store.read().conversations.every((c) => !c.binding),
    ).toBe(true);
    expect(
      (
        await server.service.invoke("coreCatalogRead", [
          "openai",
          first.workspaceId,
          "true",
        ])
      ).ok,
    ).toBe(false);
    expect(
      (await server.service.invoke("coreCatalogInstall", ["invented"])).ok,
    ).toBe(false);
    expect(
      await readFile(join(fixture.plugin, ".codex-plugin/plugin.json"), "utf8"),
    ).toBe(JSON.stringify(fixture.manifest, null, 2));
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/core-catalog-web.json",
      JSON.stringify(
        {
          passed: true,
          at: new Date().toISOString(),
          fixture,
          first,
          malformed,
          final: value(await server.service.api.coreCatalogStatus()),
          errors,
          inference: false,
          pluginInstalled: false,
          externalNetwork: false,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (!page.isClosed()) await page.goto("about:blank");
    } finally {
      try {
        await server.close();
      } finally {
        if (old === undefined) delete process.env.SYNORA_CODEX_BINARY;
        else process.env.SYNORA_CODEX_BINARY = old;
      }
    }
  }
});
