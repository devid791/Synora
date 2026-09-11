import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { test, expect, type Page } from "@playwright/test";
import type {} from "./fixtures/engine-pending-ui";

let script: string;
let provenance: unknown;
const sha = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
test.beforeAll(async () => {
  const paths = [
    "src/renderer/App.tsx",
    "src/renderer/EngineSettings.tsx",
    "tests/fixtures/engine-pending-ui.tsx",
    "tests/engine-pending.web.spec.ts",
    "playwright.engine-pending.config.ts",
  ];
  const hashes = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, sha(await readFile(path))]),
    ),
  );
  script = (
    await build({
      entryPoints: [paths[2]],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  for (const path of paths)
    expect(sha(await readFile(path))).toBe(hashes[path]);
  provenance = {
    scope:
      "Real source App, controlled deferred API, no service/Core/inference or app build",
    hashes,
    bundleSha256: sha(script),
  };
});
const send = (page: Page) =>
  page.getByRole("button", { name: "Send message", exact: true });
const message = (page: Page) =>
  page.getByRole("textbox", { name: "Message", exact: true });
const settings = (page: Page) =>
  page.getByRole("button", { name: "Open settings", exact: true }).click();
const workspace = (page: Page) =>
  page.getByRole("button", { name: "Workspace", exact: true }).click();
const calls = (page: Page, method: string) =>
  page.evaluate(
    (method) => window.enginePending.calls.filter((c) => c.method === method),
    method,
  );
const settle = (page: Page, method: string, error?: string) =>
  page.evaluate(
    ({ method, error }) => window.enginePending.settle(method, error),
    { method, error },
  );
async function mount(page: Page, axiom = false) {
  await page.route("**/*", (route) => route.abort());
  await page.setContent(
    '<title>Offline engine pending regression</title><div id="root"></div>',
  );
  for (const path of [
    "src/renderer/style.css",
    "src/renderer/OrchestrationPanel.css",
  ])
    await page.addStyleTag({
      content: (await readFile(path, "utf8")).replace(/^@import.*$/gm, ""),
    });
  await page.evaluate((axiom) => {
    window.enginePendingOptions = { axiom };
  }, axiom);
  await page.addScriptTag({ content: script });
  await expect(message(page)).toHaveValue("Retained draft");
  await test.info().attach("source-identity", {
    body: JSON.stringify(provenance, null, 2),
    contentType: "application/json",
  });
}
async function readCatalog(page: Page) {
  await settings(page);
  await page
    .getByRole("button", { name: "Read live model catalog", exact: true })
    .click();
  await expect.poll(() => calls(page, "engineModels")).toHaveLength(1);
}

for (const width of [1440, 390]) {
  test(`Tutor mode is reachable from Workspace with actionable setup at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    await mount(page);
    const entry = page.getByRole("region", { name: "Tutor mode", exact: true });
    await expect(entry).toBeVisible();
    await entry
      .getByRole("button", { name: "Set up tutor", exact: true })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "Tutor, workers and agents",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("region", { name: "Tutor setup", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByLabel("Supervisor workspace", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Add worker", exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByRole("button", {
        name: "Open supervised conversation",
        exact: true,
      }),
    ).toBeDisabled();
    await page
      .getByRole("region", { name: "Workspace model selection" })
      .getByRole("button")
      .first()
      .click();
    await expect.poll(() => calls(page, "engineModels")).toHaveLength(1);
    await settle(page, "engineModels");
    await expect(
      page.getByLabel("Workspace model", { exact: true }),
    ).toHaveValue("offline-model");
    await expect(
      page.getByRole("button", { name: "Use model", exact: true }),
    ).toBeEnabled();
    expect(await calls(page, "engineStart")).toHaveLength(0);
    expect(await page.evaluate(() => window.enginePending.unexpected)).toEqual(
      [],
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath(`tutor-${width}.png`),
      fullPage: true,
    });
  });
}
async function holdConfigure(page: Page) {
  await readCatalog(page);
  await settle(page, "engineModels");
  await page.getByRole("button", { name: /^Use live / }).click();
  await expect.poll(() => calls(page, "engineConfigure")).toHaveLength(1);
}
async function assertPending(page: Page) {
  await expect(send(page)).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Cancel turn", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("status").filter({
      hasText:
        "Sending and engine changes are unavailable until this operation finishes.",
    }),
  ).toBeVisible();
  await message(page).fill("Edited while pending");
  await message(page).press("Enter");
  // Form submission tests the independent handler guard, not only the disabled button.
  await page
    .locator("form.composer")
    .evaluate((form: HTMLFormElement) => form.requestSubmit());
  expect(await calls(page, "engineStart")).toEqual([]);
  await expect(message(page)).toHaveValue("Edited while pending");
  await expect(
    page.getByRole("combobox", { name: "Collaboration mode", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: test.info().outputPath("pending-original.png"),
  });
}
async function assertSettingsPending(page: Page) {
  // Playwright's enabled predicate does not classify fieldset itself as a
  // control. Check its native property AND the inherited disabled controls.
  await expect(page.locator(".engine-settings fieldset")).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(
    page.getByRole("button", { name: "Read live model catalog", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Engine provider", exact: true }),
  ).toBeDisabled();
}
test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() => ({
    calls: window.enginePending?.calls,
    held: window.enginePending?.held,
    unexpected: window.enginePending?.unexpected,
    engine: window.enginePending?.state.engine,
    text: document.body.innerText,
  }));
  await info.attach("actual-boundary", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  await page.screenshot({ path: info.outputPath("original.png") });
  expect(evidence.unexpected).toEqual([]);
});

test("held configuration survives navigation, blocks Send and shortcuts, then sends exactly once", async ({
  page,
}) => {
  await mount(page);
  await holdConfigure(page);
  await workspace(page);
  await assertPending(page);
  await expect(
    page.getByRole("combobox", { name: "Reasoning effort", exact: true }),
  ).toBeDisabled();
  await settings(page);
  await assertSettingsPending(page);
  await workspace(page);
  await settle(page, "engineConfigure");
  await expect(send(page)).toBeEnabled();
  await expect(message(page)).toHaveValue("Edited while pending");
  await send(page).click();
  await expect
    .poll(() => calls(page, "engineStart"))
    .toEqual([
      {
        method: "engineStart",
        args: ["offline-conversation", "Edited while pending", "text"],
      },
    ]);
});

test("held metadata disables Axiom profile/context and survives unmount until success", async ({
  page,
}) => {
  await mount(page, true);
  await readCatalog(page);
  await workspace(page);
  await assertPending(page);
  await expect(
    page.getByRole("combobox", { name: "Reasoning profile", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("combobox", { name: "Context", exact: true }),
  ).toBeDisabled();
  await settle(page, "engineModels");
  await expect(send(page)).toBeEnabled();
  expect(await calls(page, "engineConfigure")).toEqual([]);
});

test("configuration failure after unmount remains visible and a second held operation cannot unlock early", async ({
  page,
}) => {
  await mount(page);
  await holdConfigure(page);
  await workspace(page);
  await assertPending(page);
  await settle(page, "engineConfigure", "Controlled catalog validation failed");
  await expect(page.getByRole("alert")).toContainText(
    "Controlled catalog validation failed",
  );
  await expect(send(page)).toBeEnabled();
  const effort = page.getByRole("combobox", {
    name: "Reasoning effort",
    exact: true,
  });
  await effort.selectOption("high");
  await expect.poll(() => calls(page, "engineConfigure")).toHaveLength(2);
  await settings(page);
  await assertSettingsPending(page);
  await workspace(page);
  await assertPending(page);
  await settle(page, "engineConfigure");
  await expect(effort).toHaveValue("high");
  await expect(send(page)).toBeEnabled();
  expect((await calls(page, "engineConfigure"))[1].args).toEqual([
    {
      mode: "live",
      providerId: "offline-provider",
      model: "offline-model",
      reasoningEffort: "high",
    },
  ]);
  await effort.selectOption("");
  await assertPending(page);
  await settle(page, "engineConfigure");
  await expect(effort).toHaveValue("");
  expect((await calls(page, "engineConfigure"))[2].args).toEqual([
    { mode: "live", providerId: "offline-provider", model: "offline-model" },
  ]);
});

test("restore waits for configuration, stays locked through navigation, and retries failure only on explicit same-conversation action", async ({
  page,
}) => {
  await mount(page);
  await holdConfigure(page);
  await page
    .getByRole("button", {
      name: "Open conversation: Offline restore history",
      exact: true,
    })
    .click();
  await expect(message(page)).toHaveValue("History draft");
  expect(await calls(page, "engineRestore")).toEqual([]);
  await expect(send(page)).toBeDisabled();
  await settle(page, "engineConfigure");
  await expect.poll(() => calls(page, "engineRestore")).toHaveLength(1);
  await assertPending(page);
  await settings(page);
  await assertSettingsPending(page);
  await workspace(page);
  await settle(page, "engineRestore", "Controlled restore failure");
  await expect(page.getByRole("alert")).toContainText(
    "Controlled restore failure",
  );
  await expect(
    page.getByRole("button", { name: "Retry restore", exact: true }),
  ).toBeEnabled();
  await expect(message(page)).toHaveValue("Edited while pending");
  // Navigation/re-render cannot turn a failed attempt into an automatic retry.
  await settings(page);
  await workspace(page);
  expect(await calls(page, "engineRestore")).toHaveLength(1);
  await page
    .getByRole("button", { name: "Retry restore", exact: true })
    .click();
  await expect.poll(() => calls(page, "engineRestore")).toHaveLength(2);
  await assertPending(page);
  await settle(page, "engineRestore");
  await expect(send(page)).toBeEnabled();
  await expect(
    page.getByRole("button", { name: "Retry restore", exact: true }),
  ).toHaveCount(0);
  expect(await calls(page, "engineRestore")).toEqual([
    { method: "engineRestore", args: ["offline-history"] },
    { method: "engineRestore", args: ["offline-history"] },
  ]);
  // A successful attempt must not suppress restoration after reconfiguration.
  await page
    .getByRole("combobox", { name: "Reasoning effort", exact: true })
    .selectOption("high");
  await expect.poll(() => calls(page, "engineConfigure")).toHaveLength(2);
  expect(await calls(page, "engineRestore")).toHaveLength(2);
  await settle(page, "engineConfigure");
  await expect.poll(() => calls(page, "engineRestore")).toHaveLength(3);
  await assertPending(page);
  await expect(
    page.getByRole("button", { name: "Reconnect", exact: true }),
  ).toBeDisabled();
  await settle(page, "engineRestore");
  await expect(send(page)).toBeEnabled();
});

test("configuration starting during awaited draft save blocks the eventual engineStart", async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    window.enginePending.holdNextDraft = true;
  });
  await message(page).fill("Draft-save race");
  await send(page).click();
  await expect
    .poll(() => page.evaluate(() => window.enginePending.held))
    .toContain("saveDraft");
  expect(await calls(page, "engineStart")).toEqual([]);
  await page
    .getByRole("combobox", { name: "Reasoning effort", exact: true })
    .selectOption("high");
  await expect.poll(() => calls(page, "engineConfigure")).toHaveLength(1);
  await settle(page, "saveDraft");
  await expect(send(page)).toBeDisabled();
  await expect(message(page)).toHaveValue("Draft-save race");
  expect(await calls(page, "engineStart")).toEqual([]);
  await settle(page, "engineConfigure");
  await expect(send(page)).toBeEnabled();
  await send(page).click();
  await expect
    .poll(() => calls(page, "engineStart"))
    .toEqual([
      {
        method: "engineStart",
        args: ["offline-conversation", "Draft-save race", "text"],
      },
    ]);
});
