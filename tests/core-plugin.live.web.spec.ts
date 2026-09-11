import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ownedCatalogFixture } from "./fixtures/core-catalog";
import { oauthMcpServer } from "./fixtures/oauth-mcp-server";
import { startWebService } from "../src/web/server";
import type { Result } from "../src/shared/contracts";
const value = <T>(v: Result<T>) => {
  if (!v.ok) throw Error(v.error.message);
  return v.value;
};

test("Real Axiom uses an installed authenticated plugin through original Core, returns its unseen result and preserves UI/history identities", async ({
  page,
}) => {
  const endpoint = process.env.SYNORA_TEST_ENDPOINT!;
  if (!endpoint)
    throw Error(
      "Explicit Axiom endpoint required before creating a live fixture",
    );
  const oauth = await oauthMcpServer();
  oauth.lifetime(300);
  const fixture = await ownedCatalogFixture(oauth.endpoint, endpoint);
  const old = process.env.SYNORA_CODEX_BINARY;
  process.env.SYNORA_CODEX_BINARY = fixture.core;
  // Test-only isolated provider configuration: the one allowed child test was
  // already consumed. Never delegate from this qualification or edit production.
  const coreState = join(fixture.directory, "app-server", "live-axiom");
  await mkdir(coreState, { recursive: true });
  await writeFile(
    join(coreState, "config.toml"),
    "[agents]\nenabled = false\n",
    { flag: "wx", mode: 0o600 },
  );
  const options = {
    storePath: join(fixture.directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  let server = await startWebService(options);
  const errors: string[] = [],
    evidence: Record<string, unknown> = {
      at: new Date().toISOString(),
      endpoint,
      fixture,
      scope:
        "Actual Axiom/Core/plugin tool through shared web; controlled local OAuth/MCP, no public account or child agent.",
    };
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const catalog = page.getByRole("region", {
    name: "Original Core plugin catalog",
  });
  const dialog = page.getByRole("dialog", { name: "Core plugin management" });
  const read = async () => {
    await nav("Plugins & MCP");
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    await catalog.getByLabel("Catalog provider").selectOption("live-axiom");
    await nav("Read Core catalog");
    await catalog.getByLabel("Filter Core catalog").fill(fixture.name);
    const plugin = catalog.locator("article.card").filter({
      has: page.getByRole("heading", {
        name: "Synora Catalog Proof",
        exact: true,
      }),
    });
    await expect(
      plugin.getByRole("button", { name: "Inspect plugin capabilities" }),
    ).toBeEnabled();
    await plugin
      .getByRole("button", { name: "Inspect plugin capabilities" })
      .click();
    await expect(dialog.getByRole("checkbox")).toBeEnabled();
  };
  try {
    value(await server.service.api.chooseWorkspace(fixture.workspace));
    value(
      await server.service.api.integrationSave({
        id: "live-axiom",
        name: "Live Axiom plugin QA",
        kind: "provider",
        endpoint,
        enabled: true,
        auth: "none",
        tools: [],
      }),
    );
    await page.goto(server.url);
    await read();
    await dialog.getByRole("checkbox").check();
    await nav("Install plugin");
    await expect(dialog).toContainText(
      "Plugin installed and enabled; state verified by Core.",
    );
    expect(oauth.counts().grants).toBe(0);
    expect(oauth.toolCalls).toEqual([]);
    await nav("Sign in to proof");
    const authLink = dialog.getByRole("link", {
      name: "Open plugin authorization page",
    });
    await expect(authLink).toBeVisible();
    const pendingPopup = page.waitForEvent("popup");
    await authLink.click();
    const popup = await pendingPopup;
    await popup.waitForLoadState();
    await popup.close();
    await expect
      .poll(
        async () =>
          value(await server.service.api.mcpAuthorizationStatus())?.busy,
      )
      .toBe(false);
    expect(
      value(await server.service.api.mcpAuthorizationStatus())?.status,
    ).toBe("authorized");
    expect(oauth.counts().pkce).toBe(1);
    await nav("Close plugin panel");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption("live-axiom");
    await nav("Read live model catalog");
    await expect(page.getByLabel("Engine model")).toBeEnabled();
    await nav("Use live Axiom");
    await nav("Workspace");
    const workspace = server.service.store
      .read()
      .workspaces.find((w) => w.path === fixture.workspace)!;
    await page.getByLabel("Active workspace").selectOption(workspace.id);
    const prompt =
      "Call the installed Synora Catalog Proof plugin MCP tool read_fixture exactly once with no arguments. Return the exact string obtained from that tool, without additional text. Do not use shell, files, other tools or agents; do not guess the result.";
    expect(prompt).not.toContain(oauth.toolMarker);
    await page.getByLabel("Message", { exact: true }).fill(prompt);
    const sent = page.waitForResponse((r) =>
      r.url().endsWith("/api/engineStart"),
    );
    await nav("Send message");
    value(await (await sent).json());
    await expect
      .poll(() => server.service.engine.snapshot().status, { timeout: 125000 })
      .toBe("completed");
    const final = server.service.engine.snapshot();
    evidence.final = final;
    expect(final.agents).toEqual([]);
    expect(oauth.toolCalls).toHaveLength(1);
    const mounted = final.mcpServers?.find(
      (s) => s.pluginId === `${fixture.name}@personal`,
    );
    expect(mounted?.name).toBe("proof");
    expect(mounted?.authStatus).toBe("oAuth");
    expect(mounted?.tools.read_fixture).toBeTruthy();
    const calls = final.items.filter((i) => i.type === "mcpToolCall");
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.server).toBe("proof");
    expect(call.tool).toBe("read_fixture");
    expect(call.status).toBe("completed");
    expect(call.error).toBeNull();
    expect(JSON.stringify(call.result)).toContain(oauth.toolMarker);
    expect(
      final.items
        .filter((i) => i.type === "agentMessage")
        .map((i) => i.text)
        .join("\n"),
    ).toContain(oauth.toolMarker);
    expect(final.firstDeltaAt).toBeGreaterThan(final.startedAt!);
    expect(final.backendRequests?.length).toBeGreaterThan(0);
    const stored = server.service.store
      .read()
      .conversations.find((c) => c.binding?.threadId === final.threadId)!;
    expect(stored.binding?.sessionId).toBe(final.sessionId);
    expect(stored.activity.find((i) => i.id === call.id)).toEqual(call);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const row = page.locator(`[data-item-id="${call.id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("read_fixture");
      await expect(row).toContainText(oauth.toolMarker);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await row.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/core-plugin-live-web/tool-${width}.png`,
      });
    }
    await page.goto("about:blank");
    await server.close();
    server = await startWebService(options);
    await page.goto(server.url);
    const cold = server.service.store
      .read()
      .conversations.find((c) => c.id === stored.id)!;
    expect(cold.binding).toEqual(stored.binding);
    expect(cold.activity.find((i) => i.id === call.id)).toEqual(call);
    await expect(page.locator(`[data-item-id="${call.id}"]`)).toHaveCount(1);
    await expect(page.locator(".message.assistant")).toContainText(
      oauth.toolMarker,
    );
    evidence.cold = cold;
    await read();
    await dialog.getByRole("checkbox").check();
    await nav("Remove plugin");
    await expect(dialog).toContainText(
      "Plugin removed from this Synora profile; state verified by Core.",
    );
    evidence.removed = value(await server.service.api.corePluginStatus());
    expect(
      await readFile(join(fixture.plugin, ".codex-plugin/plugin.json"), "utf8"),
    ).toBe(JSON.stringify(fixture.manifest, null, 2));
    expect(oauth.failures).toEqual([]);
    expect(errors).toEqual([]);
    evidence.passed = true;
    console.log(
      JSON.stringify({
        passed: true,
        threadId: final.threadId,
        sessionId: final.sessionId,
        turnId: final.turnId,
        toolId: call.id,
        tool: call.tool,
        pluginId: mounted!.pluginId,
      }),
    );
  } finally {
    evidence.last = server.service.engine.snapshot();
    evidence.errors = errors;
    evidence.network = oauth.events;
    evidence.calls = oauth.toolCalls;
    evidence.marker = oauth.toolMarker;
    try {
      await page.goto("about:blank");
      await server.close();
    } finally {
      await oauth.close();
      if (old === undefined) delete process.env.SYNORA_CODEX_BINARY;
      else process.env.SYNORA_CODEX_BINARY = old;
      await mkdir("out/live-evidence", { recursive: true });
      await writeFile(
        "out/live-evidence/core-plugin-live-web.json",
        JSON.stringify(evidence, null, 2),
      );
    }
  }
});
