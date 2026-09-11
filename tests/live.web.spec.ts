import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWebService } from "../src/web/server";

test("Actual web UI: catalog selection, streamed Axiom tool turn, reload/resume, cancellation and telemetry", async ({
  page,
}) => {
  const endpoint = process.env.SYNORA_TEST_ENDPOINT!;
  const dir = await mkdtemp(join(tmpdir(), "synora-live-ui-")),
    workspace = join(dir, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "ui-check.txt"), "SYNORA_UI_BEFORE\n");
  const server = await startWebService({
    storePath: join(dir, "state.sqlite"),
    assets: resolve("out/web/ui"),
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  try {
    await page.goto(server.url);
    await nav("Add workspace");
    await page.getByLabel("Service folder").fill(workspace);
    await nav("Open folder");
    await nav("Models & accounts");
    await expect(page.getByRole("article", { name: "OpenAI account", exact: true }))
      .toContainText("Account checked", { timeout: 20000 });
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("live-axiom");
    await page
      .getByLabel("Configuration name")
      .fill("Live Axiom qualification");
    await page.getByLabel("Configuration endpoint").fill(endpoint);
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption("live-axiom");
    await nav("Read live model catalog");
    await expect(page.getByLabel("Engine model")).toBeEnabled();
    await nav("Use live Axiom");
    await expect(page.locator(".engine-settings")).toContainText(
      "Current mode: Axiom",
    );
    await nav("Workspace");
    await expect(page.getByLabel("Simulation scenario")).toHaveCount(0);
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "Use tools to read ui-check.txt, change its contents to SYNORA_UI_AFTER followed by a newline, and read it back to verify. Do not modify other files. Then reply exactly SYNORA_UI_TOOL_OK.",
      );
    await nav("Send message");
    await expect(page.getByLabel("Reasoning profile")).toBeDisabled();
    await expect
      .poll(() => server.service.engine.snapshot().status, { timeout: 120000 })
      .toBe("completed");
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_UI_TOOL_OK",
    );
    expect(await readFile(join(workspace, "ui-check.txt"), "utf8")).toBe(
      "SYNORA_UI_AFTER\n",
    );
    const completed = server.service.engine.snapshot(),
      conversation = server.service.store.read().conversations[0];
    expect(completed.firstDeltaAt).toBeGreaterThan(completed.startedAt!);
    expect(completed.tokenUsage?.last.outputTokens).toBeGreaterThan(0);
    expect(conversation.binding?.sessionId).toBe(completed.sessionId);
    expect(conversation.messages.every((m) => !m.simulated)).toBe(true);
    expect(conversation.activity.length).toBeGreaterThan(0);
    const toolIds = conversation.activity.map((i) => i.id);
    for (const id of toolIds)
      await expect(page.locator(`[data-item-id="${id}"]`)).toBeVisible();
    await page.reload();
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_UI_TOOL_OK",
    );
    for (const id of toolIds)
      await expect(page.locator(`[data-item-id="${id}"]`)).toHaveCount(1);
    await nav("Telemetry & backend");
    await expect(
      page
        .locator(".card")
        .filter({ has: page.getByRole("heading", { name: "Engine identity" }) })
        .locator("dl"),
    ).toContainText(completed.sessionId!);
    expect(completed.backendRequests?.length).toBeGreaterThan(0);
    await expect(page.locator(".axiom-telemetry summary")).toHaveCount(
      completed.backendRequests!.length,
    );
    await expect(page.locator(".metric-grid")).toContainText(
      "Actual App Server turn",
    );
    await nav("Workspace");
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "Write a long numbered list of 1000 detailed engineering observations. Do not use tools.",
      );
    await nav("Send message");
    await expect
      .poll(
        () =>
          !!server.service.engine.snapshot().turnId &&
          server.service.engine.snapshot().status === "running",
      )
      .toBe(true);
    await nav("Cancel turn");
    await expect
      .poll(() => server.service.engine.snapshot().status, { timeout: 30000 })
      .toBe("interrupted");
    await expect(page.getByLabel("Send message")).toBeVisible();
    await expect(page.getByLabel("Reasoning profile")).toBeEnabled();
    expect(errors).toEqual([]);
    await page.screenshot({
      path: "test-results/live-web/actual-workspace.png",
    });
    await writeFile(
      "out/live-evidence/live-ui.json",
      JSON.stringify(
        {
          dir,
          endpoint,
          completed,
          cancelled: server.service.engine.snapshot(),
          toolIds,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await page.goto("about:blank");
    await server.close();
  }
});
