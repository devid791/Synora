import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { startWebService } from "../src/web/server";

test("Actual completed delegation stays visible with original identities and telemetry after cold web startup", async ({
  page,
}) => {
  const file = process.env.SYNORA_SUPERVISOR_EVIDENCE!;
  const original = JSON.parse(await readFile(file, "utf8"));
  expect(original.passed).toBe(true);
  expect(original.receipt.supervisor ?? "actual-axiom").toBe("actual-axiom");
  const task = original.receipt.task;
  const server = await startWebService({
    storePath: join(dirname(file), "state.sqlite"),
    assets: resolve("out/web/ui"),
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(server.url);
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    const panel = page.getByRole("region", {
      name: "Worker orchestration",
      exact: true,
    });
    await expect(panel).toBeVisible();
    const card = page.getByRole("article", {
      name: `Delegated task ${task.name}`,
      exact: true,
    });
    await expect(card).toBeVisible();
    await expect
      .poll(() => server.service.engine.snapshot().connection)
      .toBe("live");
    expect(server.service.engine.snapshot().error).toBeFalsy();
    expect(server.service.engine.snapshot().threadId).toBe(task.parentThreadId);
    await expect(
      card.getByText(`${task.name} · completed`, { exact: true }),
    ).toBeVisible();
    if (task.review) {
      const section = card.getByRole("region", {
        name: "Supervisor review",
        exact: true,
      });
      await expect(
        section.getByText("Accepted", { exact: true }),
      ).toBeVisible();
      await expect(
        section.getByText(task.review.summary, { exact: true }),
      ).toBeVisible();
      await section
        .getByText("Original review identity", { exact: true })
        .click();
      await expect(
        section.getByText(task.review.callId, { exact: true }),
      ).toBeVisible();
    }
    await card.getByText("Real identities and timing", { exact: true }).click();
    for (const id of [
      task.id,
      task.parentThreadId,
      task.callId,
      task.threadId,
      task.sessionId,
      task.turnId,
    ])
      await expect(card.getByText(id, { exact: true }).first()).toBeVisible();
    await card
      .getByText("Reported worker usage and activity", { exact: true })
      .click();
    await expect(
      card.getByText("Core token usage not reported.", { exact: true }),
    ).toHaveCount(0);
    await expect(
      card.getByText("commandExecution", { exact: false }),
    ).toBeVisible();
    await expect(card.getByRole("button", { name: /Cancel/ })).toHaveCount(0);
    await page.screenshot({
      path: "test-results/orchestration-history-web/history-1440.png",
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      )
      .toBe(true);
    await card.getByText("Real identities and timing", { exact: true }).focus();
    await expect(
      card.getByText("Real identities and timing", { exact: true }),
    ).toBeFocused();
    await page.screenshot({
      path: "test-results/orchestration-history-web/history-390.png",
      fullPage: true,
    });
    expect(server.service.store.read().delegations[0].result).toBe(task.result);
    expect(server.service.store.read().delegations[0].review).toEqual(
      task.review,
    );
    expect(server.service.store.read().delegations).toHaveLength(1);
    expect(errors).toEqual([]);
  } finally {
    await server.close();
  }
});
