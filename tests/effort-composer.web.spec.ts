// CPU/browser-only regression of the real App, not a copied composer component.
// PLAYWRIGHT_BROWSERS_PATH=.cache/browsers node node_modules/@playwright/test/cli.js test --config playwright.effort-composer.config.ts
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { test, expect, type Page } from "@playwright/test";
import type { EngineConfig, ModelCapabilities } from "../src/shared/contracts";
import type { EffortComposerFixture } from "./fixtures/effort-composer-ui";

const defaultLabel = "Provider default";
const defaultTitle = "Provider default: no reasoning effort override";
const baseConfig: EngineConfig = {
  mode: "live",
  providerId: "offline-compatible",
  model: "offline-effort-model",
};
const sha256 = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
let script: string;
let provenance: Record<string, unknown>;

test.beforeAll(async () => {
  const paths = [
    "src/renderer/App.tsx",
    "src/renderer/style.css",
    "tests/fixtures/effort-composer-ui.tsx",
    "tests/effort-composer.web.spec.ts",
    "playwright.effort-composer.config.ts",
  ];
  const inputHashes = Object.fromEntries(
    await Promise.all(
      paths.map(async (path) => [path, sha256(await readFile(path))]),
    ),
  );
  const result = await build({
    entryPoints: ["tests/fixtures/effort-composer-ui.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  script = result.outputFiles[0].text;
  expect(sha256(await readFile(paths[0]))).toBe(inputHashes[paths[0]]);
  provenance = {
    scope: "Controlled full-App UI and exact engineConfigure boundary only",
    appBuild: false,
    serviceOrCoreOrInference: false,
    inputHashes,
    inMemoryBundleSha256: sha256(script),
  };
});

function initialFixture(
  options: {
    effort?: string;
    efforts?: string[];
    declaredDefault?: string;
    busy?: boolean;
  } = {},
): EffortComposerFixture {
  const model: ModelCapabilities = {
    id: baseConfig.model!,
    reasoning_efforts: options.efforts ?? ["low", "high"],
    context_window: 128000,
    context_window_options: [],
    ...(options.declaredDefault !== undefined
      ? { default_reasoning_effort: options.declaredDefault }
      : {}),
  };
  return {
    state: {
      version: 1,
      revision: 1,
      engine: {
        ...baseConfig,
        ...(options.effort !== undefined
          ? { reasoningEffort: options.effort }
          : {}),
      },
      workspaces: [],
      conversations: [
        {
          id: "offline-conversation",
          title: "Offline effort regression — no inference",
          workspaceId: null,
          draft: "",
          messages: [],
          activity: [],
          itemOrder: [],
          createdAt: 1,
        },
      ],
      integrations: [
        {
          id: baseConfig.providerId!,
          name: "Offline compatible UI fixture",
          kind: "provider",
          providerType: "compatible",
          enabled: true,
          auth: "none",
          endpoint: "https://offline-fixture.invalid/v1",
          tools: [],
        },
      ],
      presets: [],
      agentHistory: [],
      delegations: [],
      preferences: {
        mode: "default",
        view: "workspace",
        profile: "max",
        context: 1048576,
        compact: false,
      },
    },
    snapshot: {
      connection: "disconnected",
      conversationId: "offline-conversation",
      threadId: null,
      turnId: null,
      status: options.busy ? "running" : "idle",
      sequence: 1,
      items: [],
      agents: [],
      approval: null,
      modelCatalog: [model],
    },
    configureCalls: [],
    unexpectedCalls: [],
  };
}

const effortSelect = (page: Page) =>
  page.getByRole("combobox", { name: "Reasoning effort", exact: true });
const recordedCalls = (page: Page) =>
  page.evaluate(() => window.effortComposerFixture.configureCalls);

async function mount(page: Page, fixture = initialFixture()) {
  const pageErrors: string[] = [];
  const networkAttempts: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.route("**/*", async (route) => {
    // Branding is intentionally not loaded; all network access is blocked.
    if (!/\/brand\/synora(?:-light)?\.svg$/.test(route.request().url()))
      networkAttempts.push(route.request().url());
    await route.abort();
  });
  await page.setContent(
    '<title>Offline full-App effort regression</title><div id="root"></div>',
  );
  for (const path of [
    "src/renderer/style.css",
    "src/renderer/OrchestrationPanel.css",
  ])
    await page.addStyleTag({
      content: (await readFile(path, "utf8")).replace(/^@import.*$/gm, ""),
    });
  await page.evaluate((serialized) => {
    window.effortComposerFixture = JSON.parse(serialized);
  }, JSON.stringify(fixture));
  await page.addScriptTag({ content: script });
  await expect(effortSelect(page)).toBeVisible();
  await test.info().attach("source-and-overlay-identity", {
    body: JSON.stringify(provenance, null, 2),
    contentType: "application/json",
  });
  return { pageErrors, networkAttempts };
}

test.afterEach(async ({ page }, info) => {
  const evidence = await page.evaluate(() => {
    const select = document.querySelector<HTMLSelectElement>(
      '[aria-label="Reasoning effort"]',
    );
    const fixture = window.effortComposerFixture;
    return {
      engine: fixture?.state.engine,
      catalog: fixture?.snapshot.modelCatalog,
      configureCalls: fixture?.configureCalls,
      configureArgumentKeys: fixture?.configureCalls.map(([arg]) =>
        Object.keys(arg),
      ),
      unexpectedCalls: fixture?.unexpectedCalls,
      visibleSelect: select
        ? {
            value: select.value,
            disabled: select.disabled,
            title: select.title,
            selectedText: select.selectedOptions[0]?.textContent,
            options: Array.from(select.options, (option) => ({
              value: option.value,
              label: option.textContent,
              disabled: option.disabled,
              selected: option.selected,
            })),
          }
        : null,
    };
  });
  await info.attach("actual-composer-boundary", {
    body: JSON.stringify(evidence, null, 2),
    contentType: "application/json",
  });
  if (await effortSelect(page).count()) {
    await page
      .locator(".composer-controls")
      .screenshot({ path: info.outputPath("composer-original.png") });
  }
  expect(evidence.unexpectedCalls).toEqual([]);
});

test("no catalog default and no override visibly select Provider default, not the first effort", async ({
  page,
}) => {
  const observed = await mount(page);
  const select = effortSelect(page);
  await expect.soft(select).toHaveValue("");
  await expect.soft(select.locator("option:checked")).toHaveText(defaultLabel);
  await expect(select).toHaveAttribute("title", defaultTitle);
  expect(await recordedCalls(page)).toStrictEqual([]);
  expect(observed).toEqual({ pageErrors: [], networkAttempts: [] });
});

test("select high then clear sends exact engineConfigure args with the old effort key omitted", async ({
  page,
}) => {
  const observed = await mount(page);
  const select = effortSelect(page);
  await select.selectOption("high");
  await expect
    .poll(() => recordedCalls(page))
    .toStrictEqual([[{ ...baseConfig, reasoningEffort: "high" }]]);
  await expect(select).toHaveValue("high");
  await expect(select).toHaveAttribute("title", "high");
  await expect(select.locator('option[value=""]')).toHaveText(defaultLabel);
  await select.selectOption("");
  await expect
    .poll(() => recordedCalls(page))
    .toStrictEqual([
      [{ ...baseConfig, reasoningEffort: "high" }],
      [{ ...baseConfig }],
    ]);
  expect(
    Object.hasOwn((await recordedCalls(page))[1][0], "reasoningEffort"),
  ).toBe(false);
  await expect(select).toHaveValue("");
  await expect(select.locator("option:checked")).toHaveText(defaultLabel);
  await expect(select).toHaveAttribute("title", defaultTitle);
  expect(observed).toEqual({ pageErrors: [], networkAttempts: [] });
});

test("a catalog-declared default already normalized to an explicit effort stays exact", async ({
  page,
}) => {
  const observed = await mount(
    page,
    initialFixture({ effort: "high", declaredDefault: "high" }),
  );
  const select = effortSelect(page);
  await expect(select).toHaveValue("high");
  await expect(select.locator("option:checked")).toHaveText("high");
  await expect(select).toHaveAttribute("title", "high");
  await expect(select).toBeEnabled();
  expect(await recordedCalls(page)).toStrictEqual([]);
  expect(observed).toEqual({ pageErrors: [], networkAttempts: [] });
});

test("a model with no effort controls keeps the default visible and the selector disabled", async ({
  page,
}) => {
  const observed = await mount(page, initialFixture({ efforts: [] }));
  const select = effortSelect(page);
  await expect(select).toBeDisabled();
  await expect(select).toHaveValue("");
  await expect(select.locator("option:checked")).toHaveText(defaultLabel);
  await expect(select).toHaveAttribute("title", defaultTitle);
  expect(await recordedCalls(page)).toStrictEqual([]);
  expect(observed).toEqual({ pageErrors: [], networkAttempts: [] });
});

test("a stale explicit effort remains a labelled disabled sentinel, never visually aliases low", async ({
  page,
}) => {
  const observed = await mount(
    page,
    initialFixture({ effort: "stale-effort" }),
  );
  const select = effortSelect(page);
  await expect.soft(select).toHaveValue("stale-effort");
  const selected = select.locator("option:checked");
  await expect.soft(selected).toHaveText("Unavailable: stale-effort");
  await expect.soft(selected).toHaveJSProperty("disabled", true);
  await expect(select).toHaveAttribute(
    "title",
    "stale-effort is unavailable; refresh the model catalog",
  );
  expect(await recordedCalls(page)).toStrictEqual([]);
  expect(observed).toEqual({ pageErrors: [], networkAttempts: [] });
});

test("busy state preserves the explicit effort and prevents configuration changes", async ({
  page,
}) => {
  const observed = await mount(
    page,
    initialFixture({ effort: "high", busy: true }),
  );
  const select = effortSelect(page);
  await expect(select).toBeDisabled();
  await expect(select).toHaveValue("high");
  await expect(select.locator("option:checked")).toHaveText("high");
  await expect(select).toHaveAttribute("title", "high");
  expect(await recordedCalls(page)).toStrictEqual([]);
  expect(observed).toEqual({ pageErrors: [], networkAttempts: [] });
});

test("390px composer stays in bounds and supports click/keyboard high then Provider default without an override", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const observed = await mount(page);
  const select = effortSelect(page);
  await expect(select).toBeEnabled();
  await expect(select).toHaveValue("");
  await expect(select.locator("option:checked")).toHaveText(defaultLabel);
  await expect(select).toHaveAttribute("title", defaultTitle);

  const checkBounds = async () => {
    // The narrow workspace intentionally scrolls inside .content. Bring the
    // control into view as a user would before asserting viewport reachability.
    await select.scrollIntoViewIfNeeded();
    await expect(select).toBeInViewport({ ratio: 1 });
    const bounds = await select.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const controls = element
        .closest(".composer-controls")!
        .getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight },
        rootWidth: document.documentElement.scrollWidth,
        control: rect.toJSON(),
        controls: controls.toJSON(),
        hittable:
          document.elementFromPoint(
            rect.left + rect.width / 2,
            rect.top + rect.height / 2,
          ) === element,
      };
    });
    expect(bounds.rootWidth).toBeLessThanOrEqual(bounds.viewport.width);
    expect(bounds.control.width).toBeGreaterThan(0);
    expect(bounds.control.height).toBeGreaterThan(0);
    expect(bounds.control.left).toBeGreaterThanOrEqual(0);
    expect(bounds.control.top).toBeGreaterThanOrEqual(0);
    expect(bounds.control.right).toBeLessThanOrEqual(bounds.viewport.width);
    expect(bounds.control.bottom).toBeLessThanOrEqual(bounds.viewport.height);
    expect(bounds.control.left).toBeGreaterThanOrEqual(bounds.controls.left);
    expect(bounds.control.right).toBeLessThanOrEqual(bounds.controls.right);
    expect(bounds.control.top).toBeGreaterThanOrEqual(bounds.controls.top);
    expect(bounds.control.bottom).toBeLessThanOrEqual(bounds.controls.bottom);
    expect(bounds.hittable).toBe(true);
    return bounds;
  };
  const before = await checkBounds();

  // Start with a real mouse action, then reach the native select by Tab.
  // Click/End/Enter left the value unchanged on the tested Mac browser, even
  // with plain HTML. Closed-select typeahead uses trusted native
  // input/change events without substituting selectOption or dispatchEvent.
  await page.getByRole("textbox", { name: "Message", exact: true }).click();
  for (
    let tabs = 0;
    tabs < 8 &&
    !(await select.evaluate((element) => document.activeElement === element));
    tabs++
  )
    await page.keyboard.press("Tab");
  await expect(select).toBeFocused();
  await page.keyboard.press("h");
  await expect(select).toHaveValue("high");
  await expect(select).toHaveAttribute("title", "high");
  await expect
    .poll(() => recordedCalls(page))
    .toStrictEqual([[{ ...baseConfig, reasoningEffort: "high" }]]);

  // Blur/refocus resets native typeahead, so the next character starts a new
  // selection rather than extending "h". No sleep or synthetic value write.
  await page.keyboard.press("Tab");
  await expect(select).not.toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(select).toBeFocused();
  await page.keyboard.press("p");
  await expect(select).toHaveValue("");
  await expect(select.locator("option:checked")).toHaveText(defaultLabel);
  await expect(select).toHaveAttribute("title", defaultTitle);
  await expect
    .poll(() => recordedCalls(page))
    .toStrictEqual([
      [{ ...baseConfig, reasoningEffort: "high" }],
      [{ ...baseConfig }],
    ]);
  expect(
    Object.hasOwn((await recordedCalls(page))[1][0], "reasoningEffort"),
  ).toBe(false);
  const after = await checkBounds();
  await info.attach("390px-control-bounds", {
    body: JSON.stringify({ before, after }, null, 2),
    contentType: "application/json",
  });
  const screenshot = info.outputPath("composer-390-original.png");
  await page.screenshot({ path: screenshot, fullPage: true });
  await info.attach("composer-390-original", {
    path: screenshot,
    contentType: "image/png",
  });
  expect(observed).toEqual({ pageErrors: [], networkAttempts: [] });
});
