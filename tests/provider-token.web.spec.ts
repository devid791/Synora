import { test, expect } from "@playwright/test";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWebService } from "../src/web/server";
test("Bearer UI saves a masked token across service restart, verifies access, replaces and removes without exporting it", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-bearer-ui-"));
  const firstToken = `fixture-${randomBytes(24).toString("hex")}`,
    nextToken = `fixture-${randomBytes(24).toString("hex")}`;
  let accepted = firstToken;
  const requests: { path: string; authorized: boolean }[] = [];
  const endpointServer = createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${accepted}`;
    requests.push({ path: req.url!, authorized });
    if (!authorized) {
      res.writeHead(401);
      return res.end('{"error":"unauthorized"}');
    }
    if (req.url !== "/codex/v1/models") {
      res.writeHead(404);
      return res.end();
    }
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        data: [
          {
            id: "fixture-model",
            context_window: 262144,
            context_window_options: [262144],
            reasoning_efforts: ["ultra-fast"],
          },
        ],
        models: [{ slug: "fixture-model" }],
      }),
    );
  });
  await new Promise<void>((r) => endpointServer.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(endpointServer.address() as { port: number }).port}/codex/v1`;
  let service = await startWebService({
    storePath: join(dir, "state.sqlite"),
    assets: resolve("out/web/ui"),
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  try {
    await page.goto(service.url);
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("external-axiom");
    await page.getByLabel("Configuration name").fill("External Axiom");
    await page.getByLabel("Configuration endpoint").fill(endpoint);
    await page.getByLabel("Authentication method").selectOption("api-key");
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    const panel = page.getByRole("region", {
      name: "Bearer token for External Axiom",
    });
    // Passwords intentionally have no textbox role; use the exact form label.
    const secret = panel.getByLabel("Bearer token for External Axiom");
    await expect(secret).toHaveAttribute("type", "password");
    await expect(panel).toContainText("No token saved");
    await secret.fill(firstToken);
    await panel
      .getByRole("button", { name: "Save token", exact: true })
      .click();
    await expect(panel).toContainText("Token saved for this endpoint");
    await expect(secret).toHaveValue("");
    expect(JSON.stringify(service.service.store.read())).not.toContain(
      firstToken,
    );
    const status =
      await service.service.api.providerCredentialStatus("external-axiom");
    expect(JSON.stringify(status)).not.toContain(firstToken);
    expect(
      (
        await service.service.invoke("providerCredentialRead", [
          "external-axiom",
        ])
      ).ok,
    ).toBe(false);
    await panel.getByRole("button", { name: "Verify access" }).click();
    await expect(panel).toContainText(
      "Authenticated model catalog received: 1",
    );
    expect(requests.at(-1)?.authorized).toBe(true);
    await page.goto("about:blank");
    await service.close();
    service = await startWebService({
      storePath: join(dir, "state.sqlite"),
      assets: resolve("out/web/ui"),
    });
    await page.goto(service.url);
    await expect(panel).toContainText("Token saved for this endpoint");
    await expect(secret).toHaveValue("");
    await panel.getByRole("button", { name: "Verify access" }).click();
    await expect(panel).toContainText(
      "Authenticated model catalog received: 1",
    );
    // Wrong/revoked token fails honestly; explicit replacement restores access.
    accepted = nextToken;
    await panel.getByRole("button", { name: "Verify access" }).click();
    await expect(panel.getByRole("alert")).toContainText("401");
    await secret.fill(nextToken);
    await panel.getByRole("button", { name: "Replace token" }).click();
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await panel.getByRole("button", { name: "Verify access" }).click();
    await expect(panel).toContainText(
      "Authenticated model catalog received: 1",
    );
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await panel.scrollIntoViewIfNeeded();
      const inputBounds = await secret.boundingBox(), panelBounds = await panel.boundingBox();
      expect(inputBounds!.width).toBeGreaterThan(panelBounds!.width * 0.9);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      expect(await page.locator("body").textContent()).not.toContain(nextToken);
      await page.screenshot({
        path: `test-results/oauth-web/bearer-${width}.png`,
        fullPage: true,
      });
    }
    await panel.getByRole("button", { name: "Remove token" }).click();
    await expect(panel).toContainText("No token saved");
    await expect(
      panel.getByRole("button", { name: "Verify access" }),
    ).toBeDisabled();
    const before = requests.length;
    const missing = await service.service.api.engineModels("external-axiom");
    expect(missing.ok).toBe(false);
    expect(requests.length).toBe(before);
    expect(errors).toEqual([]);
    expect(requests.every((v) => v.path === "/codex/v1/models")).toBe(true);
    expect(JSON.stringify(service.service.store.read())).not.toContain(
      nextToken,
    );
    const deleted =
      await service.service.api.providerCredentialStatus("external-axiom");
    expect(deleted.ok && deleted.value.present).toBe(false);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/provider-bearer-web.json",
      JSON.stringify(
        {
          passed: true,
          dir,
          evidence:
            "Controlled loopback Bearer endpoint + actual shared UI and service restart; not public Cloudflare qualification",
          persistenceAfterRestart: true,
          inferenceRequests: 0,
          requests,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await page.goto("about:blank");
    await service.close();
    endpointServer.closeAllConnections();
    await new Promise<void>((r) => endpointServer.close(() => r()));
  }
});
