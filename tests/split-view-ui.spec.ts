// Real App/CSS, controlled read/event boundary. NOT a native/live inference pass.
import { test, expect, type Page } from "@playwright/test";
import { build } from "esbuild";
import { readFile } from "node:fs/promises";
import type {} from "./fixtures/engine-pending-ui";
let script: string, css: string, logo: string;
test.beforeAll(async () => {
  script = (
    await build({
      entryPoints: ["tests/fixtures/engine-pending-ui.tsx"],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      loader: { ".css": "empty" },
      define: { "process.env.NODE_ENV": '"production"' },
    })
  ).outputFiles[0].text;
  css = (await readFile("src/renderer/style.css", "utf8")).replace(
    /^@import.*$/gm,
    "",
  );
  logo = await readFile("public/brand/synora.svg", "utf8");
});
async function mount(page: Page) {
  // A real cold start loads durable records in the initial state response, not
  // after an empty history which correctly causes missing tabs to be pruned.
  const seed = await page.evaluate(() =>
    window.enginePending
      ? JSON.stringify({
          agentHistory: window.enginePending.state.agentHistory,
          delegations: window.enginePending.state.delegations,
          conversations: window.enginePending.state.conversations,
        })
      : null,
  );
  await page.goto("https://split-view.invalid");
  await page.addStyleTag({ content: css });
  await page.evaluate((seed) => {
    window.enginePendingOptions = {
      seed: seed ? JSON.parse(seed) : undefined,
      preferences: {
        theme: "dark",
        sidebarCollapsed: false,
        filesCollapsed: true,
      },
    };
  }, seed);
  await page.addScriptTag({ content: script });
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Retained draft");
  await page.evaluate(() => {
    const f = window.enginePending;
    f.state.agentHistory = [
      {
        id: "child-a",
        parentId: "offline-thread",
        name: "Luna QA",
        task: "Inspect this code",
        result: "First real-record text",
        status: "running",
        simulated: false,
        activity: [
          {
            type: "agentMessage",
            id: "child-message",
            text: "First real-record text",
          } as never,
        ],
      },
    ];
    f.state.delegations = [
      {
        id: "task-a",
        name: "Reviewer task",
        workerId: "reviewer",
        parentConversationId: "offline-conversation",
        parentThreadId: "parent-core",
        parentTurnId: "parent-turn",
        callId: "original-call",
        task: "Review only",
        status: "running",
        createdAt: 1,
        updatedAt: 1,
        deadlineAt: 999999,
        threadId: "worker-core",
        sessionId: "worker-session",
        turnId: "worker-turn",
        result: "",
        items: [
          {
            type: "commandExecution",
            id: "worker-tool",
            command: "printf QA",
            aggregatedOutput: "QA_ORIGINAL_OUTPUT",
            exitCode: 0,
          },
        ],
      },
    ];
    const bot = {
      id: "bot-a",
      schema: "synora.bot.v1" as const,
      name: "Reader bot",
      description: "Fixture",
      instructions: "Read only",
      kind: "coding" as const,
      profile: "low" as const,
      context: 262144 as const,
      connectorIds: [],
      enabled: true,
    };
    f.state.conversations[1].defaults = { permission: "ask", bot };
    f.state.conversations[1].messages = [
      {
        id: "bot-message",
        role: "assistant",
        text: "BOT_HISTORY_RETAINED",
        simulated: false,
      },
    ];
    f.state.conversations[1].itemOrder = ["bot-message"];
    f.state.revision++;
    f.event({ kind: "resync" } as never);
  });
}
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 960 });
  await page.route("**/*", (route) =>
    route.fulfill(
      route.request().url().endsWith(".svg")
        ? { contentType: "image/svg+xml", body: logo }
        : { contentType: "text/html", body: '<div id="root"></div>' },
    ),
  );
  await mount(page);
});
const panel = (page: Page) => page.locator("#synora-side-reader");
async function choose(page: Page, name: string) {
  if (!(await panel(page).isVisible()))
    await page
      .getByRole("button", { name: "Open side panel", exact: true })
      .click();
  const chooser = page.getByRole("combobox", {
    name: "Choose a conversation or agent",
    exact: true,
  });
  if (!(await chooser.isVisible()))
    await panel(page).getByRole("button", { name: "Add a side tab" }).click();
  await chooser.selectOption({ label: name });
}
test("Side agent and bot tabs never switch the primary chat, change policy/draft or call the engine", async ({
  page,
}, info) => {
  const before = await page.evaluate(() =>
    structuredClone(window.enginePending.state),
  );
  await choose(page, "Luna QA");
  await expect(panel(page)).toContainText("First real-record text");
  await choose(page, "Reader bot · Offline restore history");
  await expect(panel(page)).toContainText("BOT_HISTORY_RETAINED");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Retained draft");
  expect(await page.evaluate(() => window.enginePending.state)).toEqual(before);
  expect(
    await page.evaluate(() =>
      window.enginePending.calls.filter((c) =>
        /^engine|newConversation|saveDraft|conversation/.test(c.method),
      ),
    ),
  ).toEqual([]);
  await page.screenshot({ path: info.outputPath("split-agent-bot.png") });
});
test("Child streaming and original worker activity update in their own selected tab", async ({
  page,
}) => {
  await choose(page, "Luna QA");
  await page.evaluate(() => {
    const f = window.enginePending,
      agent = f.state.agentHistory[0];
    const updated = {
      ...agent,
      result: "Updated live-record text",
      activity: [
        {
          type: "agentMessage",
          id: "child-message",
          text: "Updated live-record text",
        } as never,
      ],
    };
    f.snapshot = {
      ...f.snapshot,
      agents: [updated],
      sequence: f.snapshot.sequence + 1,
    };
    f.event({ kind: "resync" } as never);
  });
  await expect(
    panel(page).locator('[data-item-id="child-message"]'),
  ).toHaveCount(1);
  await expect(panel(page)).toContainText("Updated live-record text");
  await expect(panel(page)).not.toContainText("First real-record text");
  await choose(page, "Reviewer task");
  await panel(page).getByText("commandExecution", { exact: true }).click();
  await expect(panel(page)).toContainText("QA_ORIGINAL_OUTPUT");
  await expect(panel(page)).toContainText('"exitCode": 0');
  await panel(page).getByText("Identity", { exact: true }).click();
  await expect(panel(page)).toContainText("worker-session");
  await expect(panel(page)).not.toContainText("Updated live-record text");
});
test("Tabs are deduplicated, keyboard-selectable, closable without deleting records, and restored on reload", async ({
  page,
}) => {
  await choose(page, "Luna QA");
  await choose(page, "Luna QA");
  await choose(page, "Reviewer task");
  await expect(panel(page).getByRole("tab")).toHaveCount(2);
  await panel(page).getByRole("tab", { name: "Reviewer task" }).focus();
  await page.keyboard.press("ArrowLeft");
  await expect(
    panel(page).getByRole("tab", { name: "Luna QA" }),
  ).toHaveAttribute("aria-selected", "true");
  await mount(page);
  await expect(panel(page).getByRole("tab")).toHaveCount(2);
  await panel(page).getByRole("tab", { name: "Luna QA" }).focus();
  await page.keyboard.press("Delete");
  await expect(panel(page).getByRole("tab")).toHaveCount(1);
  await expect(
    panel(page).getByRole("tab", { name: "Reviewer task" }),
  ).toBeFocused();
  expect(
    await page.evaluate(() => window.enginePending.state.agentHistory.length),
  ).toBe(1);
  await panel(page)
    .getByRole("button", { name: "Close side panel", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Retained draft");
});
test("Pointer and keyboard resizing keep both columns within the viewport", async ({
  page,
}) => {
  await choose(page, "Luna QA");
  const divider = page.getByRole("separator", { name: "Resize side panel" });
  await divider.focus();
  await divider.press("ArrowLeft");
  await expect(divider).toHaveAttribute("aria-valuenow", "48");
  const rect = await divider.boundingBox();
  expect(rect).not.toBeNull();
  await page.mouse.move(rect!.x + 3, rect!.y + rect!.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect!.x - 60, rect!.y + rect!.height / 2);
  await page.mouse.up();
  expect(Number(await divider.getAttribute("aria-valuenow"))).toBeGreaterThan(
    48,
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("Narrow viewport keeps a readable inspector and restores the untouched primary composer on close", async ({
  page,
}, info) => {
  await page.setViewportSize({ width: 683, height: 640 });
  await choose(page, "Luna QA");
  await expect(panel(page)).toBeVisible();
  await expect(page.locator(".split-primary")).toBeHidden();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({ path: info.outputPath("split-narrow.png") });
  await panel(page)
    .getByRole("button", { name: "Close side panel", exact: true })
    .click();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Retained draft");
});
test("Conversation context menu opens a bot beside while preserving the current conversation", async ({
  page,
}) => {
  await page
    .getByRole("button", {
      name: "Conversation actions: Offline restore history",
      exact: true,
    })
    .click();
  await page
    .getByRole("menuitem", { name: "Open beside", exact: true })
    .click();
  await expect(panel(page)).toContainText("BOT_HISTORY_RETAINED");
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Retained draft");
  expect(
    await page.evaluate(() =>
      window.enginePending.calls.filter((c) =>
        /^engine|newConversation/.test(c.method),
      ),
    ),
  ).toEqual([]);
});
test("Reported worker link in the main conversation opens that task directly without a new chat", async ({
  page,
}) => {
  await page
    .getByRole("button", { name: "Open beside: Reviewer task", exact: true })
    .click();
  await expect(
    panel(page).getByRole("tab", { name: "Reviewer task", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  expect(
    await page.evaluate(() =>
      window.enginePending.calls.filter((c) =>
        /^engine|newConversation/.test(c.method),
      ),
    ),
  ).toEqual([]);
});
test("Unknown worker output is inspectable text, not executable HTML", async ({
  page,
}) => {
  await page.evaluate(() => {
    const f = window.enginePending;
    f.state.delegations[0].items!.push({
      id: "unsafe",
      type: "unknownFutureTool",
      output:
        '<img src="bad" onerror="window.SPLIT_ATTACK=true"><script>window.SPLIT_ATTACK=true</script>',
    });
    f.state.revision++;
    f.event({ kind: "resync" } as never);
  });
  await choose(page, "Reviewer task");
  await panel(page).getByText("unknownFutureTool", { exact: true }).click();
  await expect(panel(page)).toContainText("window.SPLIT_ATTACK=true");
  expect(await panel(page).locator("img, script").count()).toBe(0);
  expect(
    await page.evaluate(() => Reflect.get(window, "SPLIT_ATTACK")),
  ).toBeUndefined();
});
test("Deleting a source closes only its side tab, unknown tool data stays inert", async ({
  page,
}) => {
  await choose(page, "Luna QA");
  await choose(page, "Reviewer task");
  await page.evaluate(() => {
    const f = window.enginePending;
    f.state.delegations = [];
    f.state.revision++;
    f.event({ kind: "resync" } as never);
  });
  await expect(panel(page).getByRole("tab")).toHaveCount(1);
  await expect(panel(page)).toContainText("First real-record text");
  expect(
    await page.evaluate(() => window.enginePending.state.conversations.length),
  ).toBe(2);
});
test("Reading older agent activity is not interrupted by incoming updates", async ({
  page,
}) => {
  await page.evaluate(() => {
    const f = window.enginePending;
    f.state.agentHistory[0].activity = Array.from(
      { length: 40 },
      (_, i) =>
        ({
          type: "agentMessage",
          id: `message-${i}`,
          text: `Reported activity ${i}\n${"Long original content. ".repeat(15)}`,
        }) as never,
    );
    f.state.revision++;
    f.event({ kind: "resync" } as never);
  });
  await choose(page, "Luna QA");
  const transcript = panel(page).getByRole("tabpanel");
  await transcript.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await expect(
    panel(page).getByRole("button", { name: "Latest activity", exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const f = window.enginePending;
    f.state.agentHistory[0].activity!.push({
      type: "agentMessage",
      id: "new-message",
      text: "New report at end",
    } as never);
    f.state.revision++;
    f.event({ kind: "resync" } as never);
  });
  await expect(panel(page)).toContainText("New report at end");
  expect(await transcript.evaluate((el) => el.scrollTop)).toBe(0);
  await panel(page)
    .getByRole("button", { name: "Latest activity", exact: true })
    .click();
  expect(
    await transcript.evaluate(
      (el) => el.scrollHeight - el.scrollTop - el.clientHeight,
    ),
  ).toBeLessThan(2);
});
test("Light theme, Italian labels and a phone-width viewport remain usable", async ({
  page,
}, info) => {
  await page.evaluate(() => {
    const f = window.enginePending;
    f.state.preferences = {
      ...f.state.preferences,
      theme: "light",
      locale: "it",
      sidebarCollapsed: true,
    };
    f.state.revision++;
    f.event({ kind: "resync" } as never);
  });
  await page.setViewportSize({ width: 390, height: 667 });
  await page.locator("#synora-split-toggle").click();
  await panel(page).locator("select").selectOption({ label: "Luna QA" });
  await expect(panel(page)).toContainText("First real-record text");
  await expect(panel(page)).not.toContainText(
    "Read-only · updates automatically",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const geometry = await panel(page).boundingBox();
  expect(geometry!.width).toBeGreaterThan(300);
  await page.screenshot({ path: info.outputPath("split-light-it-phone.png") });
  await panel(page).locator(".side-reader-header > button").last().click();
  await expect(page.locator(".split-primary")).toBeVisible();
});
test("Reported model reasoning folds in main and side messages without modifying stored text or user content", async ({
  page,
}, info) => {
  const original =
    "<think>Reported model text, not app-generated reasoning.</think>\n\nVISIBLE_ANSWER";
  await page.evaluate((original) => {
    const f = window.enginePending;
    f.state.conversations[0].messages = [
      { id: "literal-user", role: "user", text: original, simulated: false },
      {
        id: "reasoned-main",
        role: "assistant",
        text: original,
        simulated: false,
      },
    ];
    f.state.conversations[0].itemOrder = ["literal-user", "reasoned-main"];
    f.state.conversations[1].messages = [
      {
        id: "reasoned-bot",
        role: "assistant",
        text: original,
        simulated: false,
      },
    ];
    f.state.conversations[1].itemOrder = ["reasoned-bot"];
    f.state.revision++;
    f.event({ kind: "resync" } as never);
  }, original);
  const before = await page.evaluate(() =>
    JSON.stringify(window.enginePending.state),
  );
  await choose(page, "Reader bot · Offline restore history");
  for (const area of [page.locator(".split-primary"), panel(page)]) {
    const reasoning = area.locator(".reported-reasoning");
    await expect(reasoning).toHaveCount(1);
    await expect(reasoning.locator(".message-text")).toBeHidden();
    await expect(area.locator(".message.assistant > .message-text")).toHaveText(
      "VISIBLE_ANSWER",
    );
    await reasoning.locator("summary").click();
    await expect(reasoning.locator(".message-text")).toHaveText(
      original.split("</think>")[0] + "</think>",
    );
  }
  await expect(
    page.locator(".split-primary .message.user > .message-text"),
  ).toHaveText(original);
  expect(
    await page.evaluate(() => JSON.stringify(window.enginePending.state)),
  ).toBe(before);
  await page.screenshot({
    path: info.outputPath("reported-reasoning-native-content.png"),
  });
});
