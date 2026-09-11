// Real Synora UI/service + original Core. Upstream Responses is controlled,
// not OpenAI inference. Run in a network namespace with only loopback enabled.
import { test, expect } from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { networkInterfaces } from "node:os";
import { startWebService } from "../src/web/server";
import { sha256File } from "../src/engine/core-runtime";
import { controlledOpenAi } from "./fixtures/openai-upstream";
import type { Result } from "../src/shared/contracts";
const value = <T>(r: Result<T>) => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};
test("Original Core OpenAI provider: catalog, reasoning UI, real command round-trip, resume, account logout and namespace", async ({
  page,
}) => {
  expect(Object.keys(networkInterfaces()).sort()).toEqual(["lo"]);
  const fixture = await controlledOpenAi();
  const { directory, workspace, core, wrapper, key, requests, errors, state } =
    fixture;
  const old = process.env.SYNORA_CODEX_BINARY;
  process.env.SYNORA_CODEX_BINARY = wrapper;
  const options = {
    storePath: join(directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  let server = await startWebService(options);
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  try {
    await page.goto(server.url);
    await nav("Add workspace");
    await page.getByLabel("Service folder").fill(workspace);
    await nav("Open folder");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("openai");
    await page.getByLabel("Configuration name").fill("Owned OpenAI");
    await page.getByLabel("Provider adapter").selectOption("openai");
    await expect(page.getByLabel("Configuration endpoint")).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(page.getByLabel("Declared tools")).toBeDisabled();
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption("openai");
    await nav("Read live model catalog");
    await expect(page.locator('.engine-settings [role="alert"]')).toContainText(
      "Sign in",
    );
    expect(requests).toEqual([]);
    await nav("Models & accounts");
    const account = page.getByRole("article", { name: "OpenAI account" });
    await account.getByLabel("OpenAI sign-in method").selectOption("apiKey");
    await account.getByLabel("OpenAI API key", { exact: true }).fill(key);
    await account.getByRole("button", { name: "Save OpenAI API key" }).click();
    await expect(account).toContainText("Core sign-in completed");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption("openai");
    await nav("Read live model catalog");
    await expect(page.getByLabel("Engine model")).toBeEnabled();
    const catalog = value(await server.service.api.engineModels("openai"));
    const chosen = catalog.find(
      (m) => m.coreModel?.isDefault && m.reasoning_efforts.includes("high"),
    )!;
    expect(chosen).toBeTruthy();
    expect(chosen.coreModel?.model).toBe(chosen.id);
    expect(chosen.context_window).toBeNull();
    await page.getByLabel("Engine model").selectOption(chosen.id);
    await page.getByLabel("Model reasoning effort").selectOption("high");
    await nav("Use live OpenAI");
    await expect(page.locator(".engine-settings")).toContainText(
      "Current mode: OpenAI",
    );
    expect(value(await server.service.api.backendStatus()).mode).toBe(
      "inactive",
    );
    await nav("Workspace");
    await expect(page.getByLabel("Reasoning profile")).toHaveCount(0);
    await expect(page.getByLabel("Context", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Context: Core-managed", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Message", { exact: true })
      .fill("Read the owned provider-check.txt file and confirm its contents.");
    await nav("Send message");
    await expect
      .poll(
        () =>
          errors.length ? errors : server.service.engine.snapshot().status,
        { timeout: 30000 },
      )
      .toBe("completed");
    expect(errors).toEqual([]);
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_PROVIDER_OK",
    );
    const first = server.service.engine.snapshot();
    expect(first.firstDeltaAt).toBeTruthy();
    expect(first.selection?.context).toBeNull();
    expect(
      first.items.some(
        (i) => i.type === "commandExecution" && i.status === "completed",
      ),
    ).toBe(true);
    const generations = requests.filter(
      (r) => r.path === "/v1/responses" && r.body,
    );
    expect(generations).toHaveLength(2);
    expect(generations.every((r) => r.body.reasoning.effort === "high")).toBe(
      true,
    );
    expect(await readFile(join(workspace, "provider-check.txt"), "utf8")).toBe(
      "SYNORA_PROVIDER_FILE_OK\n",
    );
    const conversation = server.service.store.read().conversations[0];
    expect(conversation.binding?.sessionId).toBe(first.sessionId);
    await page.goto("about:blank");
    await server.close();
    server = await startWebService(options);
    await page.goto(server.url);
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_PROVIDER_OK",
    );
    await page.getByLabel("Message", { exact: true }).fill("Confirm again.");
    await nav("Send message");
    await expect
      .poll(() => server.service.engine.snapshot().status, { timeout: 30000 })
      .toBe("completed");
    expect(server.service.engine.snapshot().sessionId).toBe(first.sessionId);
    state.hold = true;
    await page
      .getByLabel("Message", { exact: true })
      .fill("Controlled stream cancellation.");
    await nav("Send message");
    await expect.poll(() => state.heldRequests).toBe(1);
    expect((await server.service.api.coreAccountLogout()).ok).toBe(false);
    await nav("Cancel turn");
    await expect
      .poll(() => server.service.engine.snapshot().status)
      .toBe("interrupted");
    await expect.poll(() => state.cancelledStreams).toBe(1);
    state.hold = false;
    await page
      .getByLabel("Message", { exact: true })
      .fill("Resume after clean cancellation.");
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
        path: `test-results/openai-provider-web/workspace-${width}.png`,
        fullPage: true,
      });
    }
    await nav("Models & accounts");
    await account
      .getByRole("button", { name: "Refresh OpenAI account" })
      .click();
    await expect(account).toContainText("API key saved");
    await account
      .getByRole("button", { name: "Sign out of Synora account" })
      .click();
    await expect(account).toContainText("Not signed in");
    await expect
      .poll(
        async () => value(await server.service.api.coreAccountStatus()).busy,
      )
      .toBe(false);
    const count = requests.length;
    const rejected = await server.service.api.engineStart(
      conversation.id,
      "No auth must not infer",
      "text",
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.message).toContain("Sign in");
    expect(requests.length).toBe(count);
    expect(JSON.stringify(server.service.store.read())).not.toContain(key);
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/openai-provider.json",
      JSON.stringify(
        {
          passed: true,
          directory,
          coreSha256: await sha256File(core),
          scope:
            "Original Core + real UI/service/command + controlled Responses, not OpenAI model inference or real external auth",
          networkInterfaces: Object.keys(networkInterfaces()),
          catalog,
          requests: requests.map((r) => ({
            path: r.path,
            authorized: r.authorized,
            completed: r.completed,
            model: r.body?.model,
            effort: r.body?.reasoning?.effort,
          })),
          toolResult: state.toolResult,
          sessionId: first.sessionId,
          threadId: first.threadId,
          firstDeltaAt: first.firstDeltaAt,
          coldResume: true,
          cancelledStreams: state.cancelledStreams,
          logoutBlocksInference: true,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await writeFile(
      join(directory, "diagnostics.json"),
      JSON.stringify(
        { errors, snapshot: server.service.engine.snapshot(), requests },
        null,
        2,
      ),
    );
    await server.service.api.engineCancel();
    await server.service.api.coreAccountLogout();
    await page.goto("about:blank");
    await server.close();
    await fixture.close();
    if (old === undefined) delete process.env.SYNORA_CODEX_BINARY;
    else process.env.SYNORA_CODEX_BINARY = old;
  }
});
