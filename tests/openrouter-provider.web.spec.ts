// Real shared UI/service + original Core + a controlled OpenRouter endpoint.
// No real OpenRouter key or public paid inference; only loopback is available.
import { test, expect } from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { startWebService } from "../src/web/server";
import { controlledOpenAi } from "./fixtures/openai-upstream";
import { sha256File } from "../src/engine/core-runtime";
import type { Result } from "../src/shared/contracts";
const value = <T>(r: Result<T>) => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};

test("OpenRouter shared UI: endpoint/key/catalog, real command, cold resume, cancellation and key removal", async ({
  page,
}) => {
  expect(Object.keys(networkInterfaces()).sort()).toEqual(["lo"]);
  const f = await controlledOpenAi({ openrouter: true });
  const old = process.env.SYNORA_CODEX_BINARY;
  process.env.SYNORA_CODEX_BINARY = f.wrapper;
  const options = {
    storePath: join(f.directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  let server = await startWebService(options);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  try {
    await page.goto(server.url);
    await nav("Add workspace");
    await page.getByLabel("Service folder").fill(f.workspace);
    await nav("Open folder");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("openrouter");
    await page.getByLabel("Configuration name").fill("Owned OpenRouter");
    await page.getByLabel("Provider adapter").selectOption("openrouter");
    await expect(page.getByLabel("Configuration endpoint")).toHaveValue(
      "https://openrouter.ai/api/v1",
    );
    await page.getByLabel("Configuration endpoint").fill(f.endpoint);
    await expect(page.getByLabel("Declared tools")).toBeDisabled();
    await expect(page.getByLabel("Authentication method")).toBeDisabled();
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    const auth = page.getByRole("region", {
      name: "Bearer token for Owned OpenRouter",
    });
    await expect(auth).toContainText("OpenRouter API key");
    await expect(auth).toContainText("No token saved");
    expect((await server.service.api.engineModels("openrouter")).ok).toBe(
      false,
    );
    expect(f.requests).toEqual([]);
    await auth.getByLabel("Bearer token for Owned OpenRouter").fill(f.key);
    await auth.getByRole("button", { name: "Save token", exact: true }).click();
    await expect(auth).toContainText("Token saved for this endpoint");
    await expect(
      auth.getByLabel("Bearer token for Owned OpenRouter"),
    ).toHaveValue("");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption("openrouter");
    await nav("Read live model catalog");
    await expect(page.getByLabel("Engine model")).toHaveValue(
      "fixture/router-model",
    );
    await expect(
      page.locator('option[value="fixture/no-tools"]'),
    ).toHaveAttribute("disabled", "");
    expect(
      (
        await server.service.api.engineConfigure({
          mode: "live",
          providerId: "openrouter",
          model: "fixture/no-tools",
        })
      ).ok,
    ).toBe(false);
    await expect(page.locator(".engine-settings")).toContainText(
      "131072 tokens",
    );
    await page.getByLabel("Model reasoning effort").selectOption("high");
    await nav("Use live OpenRouter");
    await expect(page.locator(".engine-settings")).toContainText(
      "Current mode: OpenRouter",
    );
    const backend = value(await server.service.api.backendStatus());
    expect(backend.mode).toBe("inactive");
    expect(JSON.stringify(backend)).toContain("OpenRouter");
    await nav("Workspace");
    await expect(page.getByLabel("Reasoning profile")).toHaveCount(0);
    await expect(page.getByLabel("Context", { exact: true })).toHaveCount(0);
    await page
      .getByLabel("Message", { exact: true })
      .fill("Read provider-check.txt and confirm its contents");
    await nav("Send message");
    await expect
      .poll(
        () =>
          f.errors.length ? f.errors : server.service.engine.snapshot().status,
        { timeout: 30000 },
      )
      .toBe("completed");
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_PROVIDER_OK",
    );
    const first = server.service.engine.snapshot(),
      conversation = server.service.store.read().conversations[0];
    expect(
      first.items.some(
        (i) => i.type === "commandExecution" && i.status === "completed",
      ),
    ).toBe(true);
    expect(first.firstDeltaAt).toBeLessThan(first.completedAt!);
    expect(
      await readFile(join(f.workspace, "provider-check.txt"), "utf8"),
    ).toBe("SYNORA_PROVIDER_FILE_OK\n");
    await page.goto("about:blank");
    await server.close();
    server = await startWebService(options);
    await page.goto(server.url);
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_PROVIDER_OK",
    );
    await page.getByLabel("Message", { exact: true }).fill("Confirm again");
    await nav("Send message");
    await expect
      .poll(() => server.service.engine.snapshot().status, { timeout: 30000 })
      .toBe("completed");
    expect(server.service.engine.snapshot().sessionId).toBe(first.sessionId);
    expect(server.service.engine.snapshot().threadId).toBe(first.threadId);
    f.state.hold = true;
    await page
      .getByLabel("Message", { exact: true })
      .fill("Wait for cancellation");
    await nav("Send message");
    await expect.poll(() => f.state.heldRequests).toBe(1);
    expect(
      (await server.service.api.providerCredentialDelete("openrouter")).ok,
    ).toBe(false);
    await nav("Cancel turn");
    await expect.poll(() => f.state.cancelledStreams).toBe(1);
    await expect
      .poll(() => server.service.engine.snapshot().cleanupPending ?? false)
      .toBe(false);
    f.state.hold = false;
    await page
      .getByLabel("Message", { exact: true })
      .fill("Continue after cancellation");
    await nav("Send message");
    await expect
      .poll(() => server.service.engine.snapshot().status, { timeout: 30000 })
      .toBe("completed");
    expect(server.service.engine.snapshot().sessionId).toBe(first.sessionId);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page
        .getByRole("button", { name: "Model settings", exact: true })
        .scrollIntoViewIfNeeded();
      await page.screenshot({
        path: `test-results/openrouter-provider-web/workspace-${width}.png`,
        fullPage: true,
      });
    }
    await nav("Models & accounts");
    await expect(auth).toContainText("Token saved for this endpoint");
    await auth
      .getByRole("button", { name: "Remove token", exact: true })
      .click();
    await expect(auth).toContainText("No token saved");
    const count = f.requests.length;
    const rejected = await server.service.api.engineStart(
      conversation.id,
      "Must not use old token",
      "text",
    );
    expect(rejected.ok).toBe(false);
    expect(f.requests).toHaveLength(count);
    expect(JSON.stringify(server.service.store.read())).not.toContain(f.key);
    expect(errors).toEqual([]);
    expect(f.errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/openrouter-provider-web.json",
      JSON.stringify(
        {
          passed: true,
          scope:
            "Real shared UI and original Core against controlled OpenRouter Responses, not public paid inference",
          coreSha256: await sha256File(f.core),
          sessionId: first.sessionId,
          threadId: first.threadId,
          firstDeltaAt: first.firstDeltaAt,
          completedAt: first.completedAt,
          toolResult: f.state.toolResult,
          requests: f.requests.map((r) => ({
            authorized: r.authorized,
            completed: r.completed,
            model: r.body?.model,
            effort: r.body?.reasoning?.effort,
            tools: r.body?.tools?.length,
          })),
          cancelledStreams: f.state.cancelledStreams,
          credentialRemovalBlocksReuse: true,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await writeFile(
      join(f.directory, "openrouter-ui-diagnostics.json"),
      JSON.stringify(
        {
          errors,
          fixtureErrors: f.errors,
          snapshot: server.service.engine.snapshot(),
          requests: f.requests,
        },
        null,
        2,
      ),
    );
    await server.service.api.engineCancel();
    await page.goto("about:blank");
    await server.close();
    await f.close();
    if (old === undefined) delete process.env.SYNORA_CODEX_BINARY;
    else process.env.SYNORA_CODEX_BINARY = old;
  }
});
