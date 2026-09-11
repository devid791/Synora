import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWebService } from "../src/web/server";

test("Actual web backend observation uses independent read-only status, correct sample scope and no inference", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-backend-observation-"));
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
    await nav("Telemetry & backend");
    await expect(page.locator(".backend-status")).toContainText(
      "simulator does not query a backend",
    );
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("readonly-status");
    await page
      .getByLabel("Configuration name")
      .fill("Axiom status qualification");
    await page
      .getByLabel("Configuration endpoint")
      .fill(process.env.SYNORA_TEST_ENDPOINT!);
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption("readonly-status");
    await nav("Read live model catalog");
    await nav("Use live Axiom");
    await nav("Telemetry & backend");
    const card = page.locator(".backend-status");
    await expect(card.getByText("Model loaded", { exact: true })).toBeVisible();
    await expect(
      card.getByText("GPU used / total", { exact: true }),
    ).toBeVisible();
    const observed = await server.service.api.backendStatus();
    expect(observed.ok).toBe(true);
    if (!observed.ok || observed.value.mode !== "live")
      throw new Error("No live observation");
    const { runtime, resources } = observed.value;
    expect(runtime.state).toBe("available");
    expect(resources.state).toBe("available");
    if (runtime.state !== "available" || resources.state !== "available")
      throw new Error("Invalid runtime/resource status");
    expect(runtime.data.loaded).toBe(true);
    await expect(card).toContainText("not live GPU usage");
    await expect(card).toContainText("not necessarily this conversation");
    await expect(card).toContainText(resources.data.session_id);
    const noTurn = server.service.engine.snapshot();
    expect(noTurn.threadId).toBeNull();
    expect(noTurn.turnId).toBeNull();
    expect(noTurn.items).toEqual([]);
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await card
        .getByRole("heading", { name: "Axiom backend observation" })
        .scrollIntoViewIfNeeded();
      await expect(
        card.getByRole("heading", { name: "Axiom backend observation" }),
      ).toBeInViewport();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `test-results/backend-status-live/status-${width}.png`,
        fullPage: true,
      });
      await card
        .getByText("GPU used / total", { exact: true })
        .scrollIntoViewIfNeeded();
      await expect(
        card.getByText("GPU used / total", { exact: true }),
      ).toBeInViewport();
      await page.screenshot({
        path: `test-results/backend-status-live/resources-${width}.png`,
      });
    }
    await nav("Settings");
    await nav("Use simulator");
    await nav("Telemetry & backend");
    await expect(card).toContainText("simulator does not query a backend");
    await expect(
      card.getByText("GPU used / total", { exact: true }),
    ).toHaveCount(0);
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/backend-status.json",
      JSON.stringify(
        { dir, observed, noTurn, errors, inferenceRequestsByThisTest: 0 },
        null,
        2,
      ),
    );
  } finally {
    await page.goto("about:blank");
    await server.close();
  }
});
