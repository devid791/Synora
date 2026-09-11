import { expect, type Locator, type Page } from "@playwright/test";
import type { EngineSnapshot } from "../../src/shared/contracts";
import type { controlledOpenAi } from "./openai-upstream";
export async function deepseekUiWorkflow(options: {
  page(): Page;
  fixture: Awaited<ReturnType<typeof controlledOpenAi>>;
  addWorkspace(): Promise<void>;
  restart(): Promise<void>;
  snapshot(): Promise<EngineSnapshot>;
  provider?: { id: string; name: string };
  capture(token: Locator): Promise<void>;
}) {
  const f = options.fixture,
    page = options.page;
  // Native Windows reuses prepared QA state; web/isolated defaults stay stable.
  const providerId = options.provider?.id ?? "deepseek-native";
  const providerName = options.provider?.name ?? "Owned DeepSeek API";
  const tokenLabel = `API key for ${providerName}`;
  const nav = (name: string) =>
    page().getByRole("button", { name, exact: true }).click();
  const complete = () =>
    expect
      .poll(
        async () =>
          f.errors.length ? f.errors : (await options.snapshot()).status,
        { timeout: 30000 },
      )
      .toBe("completed");
  const send = async (text: string) => {
    await page().getByLabel("Message", { exact: true }).fill(text);
    await nav("Send message");
  };
  await options.addWorkspace();
  await nav("Models & accounts");
  await nav("Add configuration");
  await page().getByLabel("Configuration ID").fill(providerId);
  await page().getByLabel("Configuration name").fill(providerName);
  await page().getByLabel("Provider adapter").selectOption("deepseek");
  await expect(page().getByLabel("Configuration endpoint")).toHaveValue(
    "https://api.deepseek.com",
  );
  await page().getByLabel("Configuration endpoint").fill(f.endpoint);
  await page().getByLabel("Enable configuration").check();
  await expect(page().getByLabel("Declared tools")).toBeDisabled();
  const authentication = page().getByLabel("Authentication method");
  await expect(authentication).toBeDisabled();
  await expect(authentication).toHaveValue("api-key");
  expect(
    await authentication
      .locator("option")
      .evaluateAll((options) =>
        options.map((o) => (o as HTMLOptionElement).value),
      ),
  ).toEqual(["api-key"]);
  await nav("Save configuration");
  const token = () =>
    page().getByRole("region", {
      name: tokenLabel,
      exact: true,
    });
  await expect(token()).toContainText("DeepSeek API key");
  await expect(token()).toContainText("No token saved");
  await token().getByLabel(tokenLabel).fill(f.key);
  await token()
    .getByRole("button", { name: "Save token", exact: true })
    .click();
  await expect(token()).toContainText("Token saved for this endpoint");
  await expect(token().getByLabel(tokenLabel)).toHaveValue("");
  await nav("Settings");
  await page().getByLabel("Engine provider").selectOption(providerId);
  await nav("Read live model catalog");
  await expect(page().getByLabel("Engine model")).toHaveValue(
    "deepseek-v4-flash",
  );
  await expect(page().locator(".engine-settings")).toContainText(
    "1000000 tokens",
  );
  await expect(
    page()
      .getByLabel("Model reasoning effort")
      .locator("option[value='xhigh']"),
  ).toHaveCount(1);
  await expect(page().getByLabel("Model reasoning effort")).toBeEnabled();
  await page().getByLabel("Model reasoning effort").selectOption("high");
  await nav("Use live DeepSeek");
  await expect(page().locator(".engine-settings")).toContainText(
    "Current mode: DeepSeek",
  );
  await nav("Workspace");
  await expect(page().getByLabel("Reasoning profile")).toHaveCount(0);
  await expect(page().getByLabel("Context", { exact: true })).toHaveCount(0);
  await send("Read provider-check.txt and confirm its contents");
  await complete();
  await expect(page().locator(".message.assistant")).toContainText(
    "SYNORA_PROVIDER_OK",
  );
  const first = await options.snapshot();
  expect(
    first.items.some(
      (x) => x.type === "commandExecution" && x.status === "completed",
    ),
  ).toBe(true);
  expect(first.firstDeltaAt).toBeLessThan(first.completedAt!);
  expect(JSON.stringify(f.state.toolResult)).toContain(
    "SYNORA_PROVIDER_FILE_OK",
  );
  await options.restart();
  await expect(page().locator(".message.assistant")).toContainText(
    "SYNORA_PROVIDER_OK",
  );
  await send("Confirm the same result again");
  await complete();
  expect((await options.snapshot()).sessionId).toBe(first.sessionId);
  expect((await options.snapshot()).threadId).toBe(first.threadId);
  f.state.hold = true;
  await send("Hold for cancellation");
  await expect.poll(() => f.state.heldRequests).toBe(1);
  await nav("Cancel turn");
  await expect.poll(() => f.state.cancelledStreams).toBe(1);
  await expect
    .poll(async () => (await options.snapshot()).cleanupPending ?? false)
    .toBe(false);
  f.state.hold = false;
  await send("Continue after cancellation");
  await complete();
  expect((await options.snapshot()).threadId).toBe(first.threadId);
  await nav("Models & accounts");
  await expect(token()).toContainText("Token saved for this endpoint");
  await options.capture(token());
  await token()
    .getByRole("button", { name: "Remove token", exact: true })
    .click();
  await expect(token()).toContainText("No token saved");
  expect(f.errors).toEqual([]);
  return {
    providerId,
    providerName,
    first,
    final: await options.snapshot(),
    toolResult: f.state.toolResult,
    requests: f.requests,
    cancelledStreams: f.state.cancelledStreams,
    errors: f.errors,
  };
}
