import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { startWebService } from "../src/web/server";
import { updaterFixture } from "./core-updater-fixture";
test("Shared UI: real update transaction, durable notification/preferences, idle guard and explicit recovery", async ({
  page,
}, info) => {
  const root = await mkdtemp(join(tmpdir(), "synora-update-ui-"));
  const fixture = await updaterFixture(root);
  const options = {
    storePath: join(root, "state", "state.sqlite"),
    assets: resolve("out/web/ui"),
    coreUpdateOptions: { ...fixture.options, initialDelayMs: 200 },
  };
  let service = await startWebService(options);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(service.url);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const card = page.getByRole("article", { name: "App Server updates" });
    await expect(card).toContainText("0.153.4");
    await expect(card).toContainText("0.153.6");
    await expect(card).toContainText("0.153.5");
    await expect(
      card.getByRole("button", { name: "Update App Server", exact: true }),
    ).toBeEnabled();
    await card
      .getByRole("checkbox", { name: "Automatically check App Server updates" })
      .uncheck();
    await expect
      .poll(() =>
        service.service.api
          .coreUpdateStatus()
          .then((r) => r.ok && r.value.automatic),
      )
      .toBe(false);
    // Real service admission, not a disabled UI alone, protects active turns.
    const state = service.service.store.read();
    const c =
      state.conversations[0] ?? service.service.store.conversation(null);
    await service.service.api.engineStart(
      c.id,
      "fixture waiting turn",
      "approval",
    );
    const rejected = await service.service.invoke("coreUpdateInstall", [
      "0.153.5",
    ]);
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).toMatch(/active turn/);
    await service.service.api.engineCancel();
    await expect(
      card.getByRole("button", { name: "Update App Server", exact: true }),
    ).toBeEnabled();
    await card
      .getByRole("button", { name: "Update App Server", exact: true })
      .click();
    await expect(card).toContainText("App Server 0.153.5 activated");
    await expect(card).toContainText("complete payload");
    await page.setViewportSize({ width: 390, height: 844 });
    await card.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await info.attach("updater-390", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await service.close();
    service = await startWebService(options);
    await page.goto(service.url);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(card).toContainText("App Server 0.153.5 activated");
    await expect(
      card.getByRole("checkbox", {
        name: "Automatically check App Server updates",
      }),
    ).not.toBeChecked();
    await card.locator("summary").click();
    await expect(
      card.getByRole("button", {
        name: "Restore previous App Server",
        exact: true,
      }),
    ).toBeDisabled();
    await card
      .getByRole("checkbox", { name: "Confirm App Server recovery" })
      .check();
    await card
      .getByRole("button", { name: "Restore previous App Server", exact: true })
      .click();
    await expect(card).toContainText("Restored App Server 0.153.4");
    expect(errors).toEqual([]);
  } finally {
    await service.close();
    await rm(root, { recursive: true, force: true });
  }
});
