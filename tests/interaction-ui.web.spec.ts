import { test, expect } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
for (const width of [1440, 390])
  test(`OAuth UI fixture requires explicit open, cancellation, retry and terminal success at ${width}px`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    const script = await build({
      entryPoints: ["tests/fixtures/mcp-signin-ui.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      '<main style="padding:16px;width:100%;max-width:900px"><p>OAuth UI fixture, not a provider login</p><div id="root"></div></main>',
    );
    await page.addStyleTag({
      content: await readFile("src/renderer/style.css", "utf8"),
    });
    await page.addScriptTag({ content: script.outputFiles[0].text });
    const card = page.getByRole("article", { name: "MCP browser sign-in" });
    await card.getByRole("button", { name: "Start browser sign-in" }).focus();
    await page.keyboard.press("Enter");
    await expect(card).toContainText("awaiting browser");
    await expect(
      card.getByRole("combobox", { name: "OAuth MCP integration" }),
    ).toBeDisabled();
    await expect(card).not.toContainText("Browser sign-in completed");
    await card.getByRole("button", { name: "Open authorization page" }).click();
    expect(await page.evaluate(() => (window as any).authCalls)).toEqual([
      "start:fixture:axiom",
      "open:attempt-1",
    ]);
    await card.getByRole("button", { name: "Cancel sign-in" }).click();
    await expect(card).toContainText("cancelled");
    await expect(
      card.getByRole("button", { name: "Open authorization page" }),
    ).toHaveCount(0);
    await card.getByRole("button", { name: "Start browser sign-in" }).click();
    await page.evaluate(() => (window as any).authFail());
    await expect(card).toContainText("Core rejected sign-in");
    await card.getByRole("button", { name: "Start browser sign-in" }).click();
    await page.evaluate(() => (window as any).authComplete());
    await expect(card).toContainText("Browser sign-in completed");
    await expect(card).toContainText("not current tool availability");
    await expect(
      card.getByRole("button", { name: "Cancel sign-in" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect(errors).toEqual([]);
    await page.screenshot({
      path: `test-results/interaction-ui/oauth-${width}.png`,
      fullPage: true,
    });
  });
for (const width of [1440, 390])
  test(`Agent UI fixture preserves work vs closure, metadata errors and keyboard at ${width}px`, async ({
    page,
  }) => {
    const script = await build({
      entryPoints: ["tests/fixtures/agent-ui.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      '<main style="padding:16px;width:100%;max-width:900px"><p>Agent UI fixture, not a live run</p><div id="root"></div></main>',
    );
    await page.addStyleTag({
      content: await readFile("src/renderer/style.css", "utf8"),
    });
    await page.addScriptTag({ content: script.outputFiles[0].text });
    const card = page.getByRole("article", { name: "Agent Darwin" });
    await expect(card).toContainText("Live · completed");
    await expect(card).toContainText("Closed");
    await expect(card).toContainText("CHILD_RESULT");
    await expect(card).toContainText(
      "No completed Axiom measurement is available for this agent.",
    );
    await card.getByText("Identity and timing", { exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(card).toContainText("child-core-session");
    await card
      .getByRole("button", { name: "Open parent conversation" })
      .focus();
    await page.keyboard.press("Enter");
    expect(await page.evaluate(() => window.parentOpened)).toBe(
      "fixture-parent-with-long-identity",
    );
    await expect(page.getByRole("status")).toContainText(
      "Metadata unavailable",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/interaction-ui/agent-${width}.png`,
      fullPage: true,
    });
  });
for (const width of [1440, 390])
  test(`Backend observation UI fixture: busy is not offline, partial errors and exact retry at ${width}px`, async ({
    page,
  }) => {
    const script = await build({
      entryPoints: ["tests/fixtures/backend-status-ui.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await page.setViewportSize({ width, height: 900 });
    // Freeze interval polling only in this controlled fixture; retry is actual UI.
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await page.setContent(
      '<main style="padding:16px;width:100%;max-width:900px"><p>UI fixture, not live status</p><div id="root"></div></main>',
    );
    await page.addStyleTag({
      content: await readFile("src/renderer/style.css", "utf8"),
    });
    await page.addScriptTag({ content: script.outputFiles[0].text });
    const card = page.locator(".backend-status"),
      button = page.getByRole("button", { name: "Refresh backend status" });
    await expect(card).toContainText("Fixture simulator");
    await button.focus();
    await page.keyboard.press("Enter");
    await expect(card).toContainText("Busy (at observation)");
    await expect(card).toContainText("Resource status unavailable");
    await expect(card).toContainText("not queue depth");
    await expect(card).toContainText("not live GPU usage");
    await expect(
      card.locator("dt").filter({ hasText: "GPU used" }),
    ).toHaveCount(0);
    await button.click();
    await expect(card.getByRole("alert")).toContainText(
      "Fixture transport error",
    );
    await expect(card).not.toContainText("Busy (at observation)");
    await button.click();
    await expect(card).toContainText("Busy (at observation)");
    await expect(card.getByRole("alert")).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/interaction-ui/backend-${width}.png`,
      fullPage: true,
    });
  });
for (const width of [1440, 390])
  test(`Axiom telemetry component fixture: missing data, exact thinking, keyboard and long IDs at ${width}px`, async ({
    page,
  }) => {
    const script = await build({
      entryPoints: ["tests/fixtures/axiom-telemetry-ui.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      '<main style="padding:16px;width:100%;max-width:900px"><p>UI fixture, not a live measurement</p><div id="root"></div></main>',
    );
    await page.addStyleTag({
      content: await readFile("src/renderer/style.css", "utf8"),
    });
    await page.addScriptTag({ content: script.outputFiles[0].text });
    const empty = page.locator(".axiom-telemetry").first(),
      measured = page.locator(".axiom-telemetry").last();
    await expect(empty).toContainText("No completed Axiom measurement");
    await expect(empty.locator("dl")).toHaveCount(0);
    await expect(
      measured.locator("dt").getByText("Thinking tokens", { exact: true }),
    ).toBeVisible();
    await expect(measured.locator("dl").first()).toContainText("48");
    const first = measured.locator("summary").first();
    await first.focus();
    await page.keyboard.press("Enter");
    await expect(measured.locator("details").first()).toHaveAttribute(
      "open",
      "",
    );
    await expect(measured.locator("details").first()).toContainText(
      "24 / 4,096",
    );
    await expect(measured.locator("details").first()).toContainText(
      "60.0 / 12.0 tok/s",
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/interaction-ui/telemetry-${width}.png`,
      fullPage: true,
    });
  });
for (const width of [1440, 390])
  test(`Interactive question component fixture: options, private answer, retry and keyboard at ${width}px`, async ({
    page,
  }) => {
    const script = await build({
      entryPoints: ["tests/fixtures/question-ui.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      '<main style="padding:16px;width:100%;max-width:900px"><p>Controlled component fixture — no inference</p><div id="root"></div></main>',
    );
    await page.addStyleTag({
      content: await readFile("src/renderer/style.css", "utf8"),
    });
    await page.addScriptTag({ content: script.outputFiles[0].text });
    const form = page.getByRole("form", { name: "Model question" }),
      button = page.getByRole("button", { name: "Send answer" });
    await expect(form).toBeVisible();
    await expect(button).toBeDisabled();
    await page.getByRole("radio", { name: "A First supported option" }).check();
    await page
      .getByLabel("Answer: Private")
      .fill("fixture-only-not-a-real-secret");
    await expect(page.getByLabel("Answer: Private")).toHaveAttribute(
      "type",
      "password",
    );
    await expect(button).toBeEnabled();
    await page.getByRole("radio", { name: "Custom answer" }).check();
    await expect(button).toBeDisabled();
    await page.getByLabel("Answer: Choice").fill("A custom fixture answer");
    await button.click();
    await expect(
      page.getByRole("button", { name: "Sending answer…" }),
    ).toBeDisabled();
    await expect(page.getByRole("alert")).toHaveText(
      "Controlled retry: no answer accepted",
    );
    await expect(page.getByLabel("Answer: Choice")).toHaveValue(
      "A custom fixture answer",
    );
    await button.focus();
    await page.keyboard.press("Enter");
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (window as unknown as { fixtureComplete: boolean }).fixtureComplete,
        ),
      )
      .toBe(true);
    const calls = await page.evaluate(
      () => (window as unknown as { fixtureCalls: unknown[] }).fixtureCalls,
    );
    expect(calls).toEqual(
      Array(2).fill({
        id: "fixture-ui-request",
        answers: {
          choice: ["A custom fixture answer"],
          private: ["fixture-only-not-a-real-secret"],
        },
      }),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    const bounds = await form.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(0);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width);
    await page.screenshot({
      path: `test-results/interaction-ui/question-${width}.png`,
    });
  });

for (const platform of ["darwin", "linux"])
  test(`Native tools on ${platform} are not presented as a disabled Windows prerequisite`, async ({
    page,
  }) => {
    const script = await build({
      entryPoints: ["tests/fixtures/native-setup-ui.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await page.setContent('<main><div id="root"></div></main>');
    await page.evaluate((value) => {
      (window as unknown as { servicePlatform: string }).servicePlatform =
        value;
    }, platform);
    await page.addScriptTag({ content: script.outputFiles[0].text });
    await expect(page.getByTestId("native-tools-policy")).toContainText(
      "both direct and Tutor sessions",
    );
    await expect(page.getByTestId("native-tools-platform")).toContainText(
      platform === "darwin" ? "macOS" : "Linux",
    );
    await expect(
      page.getByText("Native tool prerequisites", { exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Check native tool setup" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => (window as unknown as { fixtureCalls: unknown[] }).fixtureCalls,
      ),
    ).toEqual([]);
    await page.getByLabel("Engine provider").selectOption("fixture-provider");
    await page.getByRole("button", { name: "Read live model catalog" }).click();
    await page.getByRole("button", { name: "Use live Axiom" }).click();
    await expect(page.getByTestId("native-tools-policy")).toBeVisible();
    await expect(page.getByText("notApplicable", { exact: false })).toHaveCount(
      0,
    );
  });

for (const width of [1440, 390])
  test(`Native setup UI fixture: explicit actions, pending, denial, retry and live-mode boundary at ${width}px`, async ({
    page,
  }) => {
    const script = await build({
      entryPoints: ["tests/fixtures/native-setup-ui.tsx"],
      bundle: true,
      write: false,
      format: "iife",
      platform: "browser",
      define: { "process.env.NODE_ENV": '"production"' },
    });
    await page.setViewportSize({ width, height: 900 });
    await page.setContent(
      '<main style="padding:16px;width:100%;max-width:900px"><p>Controlled setup component fixture — no OS setup</p><div id="root"></div></main>',
    );
    await page.addStyleTag({
      content: await readFile("src/renderer/style.css", "utf8"),
    });
    await page.addScriptTag({ content: script.outputFiles[0].text });
    await page.getByText("Native tool prerequisites", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Check native tool setup" }),
    ).toBeDisabled();
    await page.getByLabel("Engine provider").selectOption("fixture-provider");
    await page.getByRole("button", { name: "Check native tool setup" }).click();
    await expect(
      page.getByRole("button", { name: "Check native tool setup" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("status").filter({ hasText: "Native setup:" }),
    ).toContainText("notConfigured");
    await page
      .getByRole("button", { name: "Set up administrator sandbox" })
      .click();
    await expect(
      page
        .getByRole("status")
        .filter({ hasText: "Preparing the Windows sandbox" }),
    ).toContainText("several minutes; keep Synora open");
    await expect(page.getByRole("alert")).toContainText(
      "Administrator setup declined; nothing configured",
    );
    await expect(
      page.getByRole("status").filter({ hasText: "Native setup:" }),
    ).toContainText("notConfigured");
    await page
      .getByRole("button", { name: "Set up restricted-token sandbox" })
      .click();
    await expect(
      page.getByRole("status").filter({ hasText: "Native setup:" }),
    ).toContainText("ready");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await page.getByRole("button", { name: "Read live model catalog" }).click();
    await expect(page.getByLabel("Engine model")).toHaveValue("fixture-model");
    await page.getByRole("button", { name: "Use live Axiom" }).click();
    await expect(
      page.getByRole("button", { name: "Set up administrator sandbox" }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Set up restricted-token sandbox" }),
    ).toBeDisabled();
    const calls = await page.evaluate(
      () => (window as unknown as { fixtureCalls: unknown[] }).fixtureCalls,
    );
    expect(calls).toEqual(
      [null, "elevated", "unelevated"].map((mode) => ({
        providerId: "fixture-provider",
        workspaceId: "fixture-workspace",
        mode,
      })),
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/interaction-ui/native-setup-${width}.png`,
      fullPage: true,
    });
  });
