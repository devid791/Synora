// Offline component tests only. No app build, Core, worker or provider is run.
// Run: npx playwright test --config playwright.orchestration-panel.config.ts
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { test, expect, type Page } from "@playwright/test";
import type { AppState, ModelCapabilities } from "../src/shared/contracts";

const model = (
  id: string,
  efforts: string[],
  contexts: number[] = [],
): ModelCapabilities => ({
  id,
  reasoning_efforts: efforts,
  context_window: contexts[0] ?? 128000,
  context_window_options: contexts,
});
const catalogs = {
  claude: [
    model("fixture-claude", ["low", "high"]),
    { ...model("not-usable", ["low"]), unavailableReason: "Tools unavailable" },
  ],
  axiom: [model("fixture-qwen", ["ultra-fast", "xhigh"], [65536, 131072])],
};
function initialState(): AppState {
  return {
    version: 1,
    revision: 1,
    engine: {
      mode: "live",
      providerId: "claude",
      model: "fixture-supervisor",
      reasoningEffort: "high",
    },
    workspaces: [
      { id: "parent", name: "Supervisor", path: "/fixture/parent" },
      { id: "w1", name: "First worker", path: "/fixture/worker-one" },
      { id: "w2", name: "Second worker", path: "/fixture/worker-two" },
    ],
    conversations: ["conversation-one", "conversation-two"].map((id) => ({
      id,
      title: id,
      workspaceId: "parent",
      draft: "",
      messages: [],
      activity: [],
      itemOrder: [],
      createdAt: 1,
    })),
    integrations: [
      {
        id: "claude",
        name: "Configured Claude",
        kind: "provider",
        providerType: "anthropic",
        enabled: true,
        auth: "api-key",
        endpoint: "https://fixture.invalid",
        tools: [],
      },
      {
        id: "axiom",
        name: "Configured Axiom",
        kind: "provider",
        providerType: "axiom",
        enabled: true,
        auth: "none",
        endpoint: "http://fixture.invalid",
        tools: [],
      },
      {
        id: "disabled",
        name: "Disabled provider",
        kind: "provider",
        providerType: "xai",
        enabled: false,
        auth: "api-key",
        endpoint: "https://fixture.invalid",
        tools: [],
      },
      {
        id: "connector",
        name: "Not a provider",
        kind: "connector",
        enabled: true,
        auth: "none",
        endpoint: "",
        tools: [],
      },
    ],
    presets: [],
    agentHistory: [],
    delegations: [],
    preferences: {
      mode: "default",
      view: "agents",
      profile: "max",
      context: 1048576,
      compact: false,
    },
  };
}

let script: string;
test.beforeAll(async () => {
  const result = await build({
    entryPoints: ["tests/fixtures/orchestration-panel-ui.tsx"],
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    loader: { ".css": "empty" },
    define: { "process.env.NODE_ENV": '"production"' },
  });
  script = result.outputFiles[0].text;
});

async function mount(
  page: Page,
  state = initialState(),
  conversationId: string | null = "conversation-one",
) {
  await page.route("**/*", (route) => route.abort());
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setContent(
    '<main style="padding:12px;max-width:1000px"><p>Offline orchestration UI fixture; no provider or worker execution.</p><div id="root"></div></main>',
  );
  await page.addStyleTag({
    content: (await readFile("src/renderer/style.css", "utf8")).replace(
      /^@import.*$/gm,
      "",
    ),
  });
  await page.addStyleTag({
    content: await readFile("src/renderer/OrchestrationPanel.css", "utf8"),
  });
  await page.evaluate((serialized) => {
    const { state, catalogs, conversationId } = JSON.parse(serialized);
    (window as any).orchestrationFixture = {
      state,
      catalogs,
      conversationId,
      busy: false,
      calls: [],
      accepted: [],
      errors: [],
      failures: {},
      requests: [],
      holdCatalogs: false,
    };
  }, JSON.stringify({ state, catalogs, conversationId }));
  await page.addScriptTag({ content: script });
  await expect(
    page.getByRole("heading", { name: "Supervisor and workers" }),
  ).toBeVisible();
  return { page, errors };
}
async function configureWorker(
  page: Page,
  number: number,
  provider = "claude",
  workspace = "w1",
) {
  await page.getByRole("button", { name: "Add worker", exact: true }).click();
  await page
    .getByRole("combobox", { name: `Worker ${number} provider`, exact: true })
    .selectOption(provider);
  await page
    .getByRole("combobox", { name: `Worker ${number} model`, exact: true })
    .selectOption(provider === "axiom" ? "fixture-qwen" : "fixture-claude");
  if (provider === "axiom") {
    await page
      .getByRole("combobox", { name: `Worker ${number} effort`, exact: true })
      .selectOption("xhigh");
    await page
      .getByRole("combobox", { name: `Worker ${number} context`, exact: true })
      .selectOption("131072");
  }
  await page
    .getByRole("combobox", { name: `Worker ${number} workspace`, exact: true })
    .selectOption(workspace);
}
const consent = (page: Page) =>
  page.getByRole("checkbox", { name: /I confirm that delegated task content/ });
const save = (page: Page) =>
  page.getByRole("button", { name: "Save worker configuration" });

test("only enabled providers and exact advertised model contracts can be saved, with separate workspaces and consent", async ({
  page,
}) => {
  const { errors } = await mount(page);
  try {
    const supervisor = page.getByRole("definition");
    await expect(supervisor.filter({ hasText: /^high$/ })).toHaveCount(1);
    await expect(supervisor.filter({ hasText: /^max$/ })).toHaveCount(0);
    await configureWorker(page, 1);
    assert.deepEqual(
      await page
        .getByRole("combobox", { name: "Worker 1 provider", exact: true })
        .locator("option")
        .evaluateAll((nodes) =>
          nodes.map((n) => (n as HTMLOptionElement).value),
        ),
      ["", "claude", "axiom"],
    );
    assert.deepEqual(
      await page
        .getByRole("combobox", { name: "Worker 1 effort", exact: true })
        .locator("option")
        .allTextContents(),
      ["Provider default (no effort override)", "low", "high"],
    );
    await expect(
      page.getByRole("textbox", { name: "Worker 1 model", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("combobox", { name: "Worker 1 context", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByText(/Model-managed context: 128,000/),
    ).toBeVisible();
    await expect(
      page
        .getByRole("combobox", { name: "Worker 1 model", exact: true })
        .locator('option[value="not-usable"]'),
    ).toHaveJSProperty("disabled", true);
    await configureWorker(page, 2, "axiom", "w2");
    assert.deepEqual(
      await page
        .getByRole("combobox", { name: "Worker 2 effort", exact: true })
        .locator("option")
        .allTextContents(),
      ["Select an advertised profile", "ultra-fast", "xhigh"],
    );
    assert.deepEqual(
      await page
        .getByRole("combobox", { name: "Worker 2 context", exact: true })
        .locator("option")
        .evaluateAll((nodes) =>
          nodes.map((n) => (n as HTMLOptionElement).value),
        ),
      ["", "65536", "131072"],
    );
    const workspace = page.getByRole("combobox", {
      name: "Worker 2 workspace",
      exact: true,
    });
    await expect(workspace.locator('option[value="parent"]')).toHaveJSProperty(
      "disabled",
      true,
    );
    await expect(workspace.locator('option[value="w1"]')).toHaveJSProperty(
      "disabled",
      true,
    );
    await expect(save(page)).toBeDisabled();
    await consent(page).check();
    await expect(save(page)).toBeEnabled();
    await page
      .getByRole("group", { name: "Worker 2 · Worker 2", exact: true })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("orchestration-configuration.png"),
      fullPage: true,
    });
    await page
      .getByRole("spinbutton", { name: "Worker 2 timeout seconds" })
      .fill("45");
    await expect(consent(page)).not.toBeChecked();
    await consent(page).check();
    await page.evaluate(() => {
      (window as any).orchestrationFixture.failures.orchestrationConfigure = 1;
    });
    await save(page).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("alert")).toHaveText(
      "Controlled orchestrationConfigure failure",
    );
    await expect(
      page.getByRole("combobox", { name: "Worker 2 model", exact: true }),
    ).toHaveValue("fixture-qwen");
    await save(page).click();
    await expect(
      page.getByText("Worker configuration · 2 saved", { exact: true }),
    ).toBeVisible();
    const calls = await page.evaluate(() =>
      (window as any).orchestrationFixture.calls.filter(
        (c: any) => c.name === "orchestrationConfigure",
      ),
    );
    assert.deepEqual(calls[1].args, [
      "conversation-one",
      {
        externalSharingConfirmed: true,
        workers: [
          {
            id: "worker_1",
            name: "Worker 1",
            selection: { providerId: "claude", model: "fixture-claude" },
            workspaceId: "w1",
            timeoutMs: 300000,
          },
          {
            id: "worker_2",
            name: "Worker 2",
            selection: {
              providerId: "axiom",
              model: "fixture-qwen",
              effort: "xhigh",
              context: 131072,
            },
            workspaceId: "w2",
            timeoutMs: 45000,
          },
        ],
      },
    ]);
    await page
      .getByRole("button", { name: "Use single-provider mode" })
      .click();
    await expect(
      page.getByText("Worker configuration · single-provider mode", {
        exact: true,
      }),
    ).toBeVisible();
    assert.deepEqual(
      await page.evaluate(
        () => (window as any).orchestrationFixture.calls.at(-1).args,
      ),
      ["conversation-one", null],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("catalog failure, refresh, stale configuration and out-of-order responses cannot authorize an unadvertised selection", async ({
  page,
}) => {
  await mount(page);
  try {
    await page.evaluate(() => {
      (window as any).orchestrationFixture.holdCatalogs = true;
    });
    await page.getByRole("button", { name: "Add worker", exact: true }).click();
    const provider = page.getByRole("combobox", {
      name: "Worker 1 provider",
      exact: true,
    });
    await provider.selectOption("claude");
    await provider.selectOption("axiom");
    await provider.selectOption("claude");
    await expect(
      page.getByRole("combobox", { name: "Worker 1 model", exact: true }),
    ).toBeDisabled();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.requests[2].resolve(q.catalogs.claude);
      q.requests[0].resolve([
        {
          id: "stale-fiction",
          reasoning_efforts: ["max"],
          context_window: 1,
          context_window_options: [],
        },
      ]);
      q.requests[1].resolve(q.catalogs.axiom);
    });
    const modelSelect = page.getByRole("combobox", {
      name: "Worker 1 model",
      exact: true,
    });
    await modelSelect.selectOption("fixture-claude");
    await expect(
      modelSelect.locator("option").filter({ hasText: "stale-fiction" }),
    ).toHaveCount(0);
    await page
      .getByRole("combobox", { name: "Worker 1 workspace", exact: true })
      .selectOption("w1");
    await consent(page).check();
    await expect(save(page)).toBeEnabled();
    await page
      .getByRole("button", { name: "Read / refresh model catalog" })
      .click();
    await expect(save(page)).toBeDisabled();
    await page.evaluate(() => {
      (window as any).orchestrationFixture.requests[3].reject(
        new Error("Controlled catalog unavailable"),
      );
    });
    await expect(page.getByRole("alert")).toContainText(
      "Controlled catalog unavailable",
    );
    await expect(modelSelect).toBeDisabled();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.holdCatalogs = false;
    });
    await page
      .getByRole("button", { name: "Read / refresh model catalog" })
      .click();
    await expect(save(page)).toBeEnabled();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.state = {
        ...q.state,
        integrations: q.state.integrations.map((p: any) =>
          p.id === "claude" ? { ...p, endpoint: "https://changed.invalid" } : p,
        ),
      };
      q.render();
    });
    await expect(save(page)).toBeDisabled();
    await expect(modelSelect).toBeDisabled();
    await page
      .getByRole("button", { name: "Read / refresh model catalog" })
      .click();
    await expect(consent(page)).not.toBeChecked();
    await consent(page).check();
    await expect(save(page)).toBeEnabled();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.catalogs.claude = [];
    });
    await page
      .getByRole("button", { name: "Read / refresh model catalog" })
      .click();
    await expect(save(page)).toBeDisabled();
    assert.equal(
      await page.evaluate(() =>
        (window as any).orchestrationFixture.calls.some(
          (c: any) => c.name === "orchestrationConfigure",
        ),
      ),
      false,
    );
  } finally {
    await page.close();
  }
});

test("no conversation/history/binding locks configuration; switching conversations discards unsaved recipients", async ({
  page,
}) => {
  await mount(page, initialState(), null);
  try {
    await page
      .getByText("Worker configuration · single-provider mode", { exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Add worker", exact: true }),
    ).toBeDisabled();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.conversationId = "conversation-one";
      q.render();
    });
    await configureWorker(page, 1);
    await consent(page).check();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.conversationId = "conversation-two";
      q.render();
    });
    await expect(
      page.getByRole("combobox", { name: "Worker 1 provider", exact: true }),
    ).toHaveCount(0);
    await expect(consent(page)).not.toBeChecked();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.state.conversations[1].messages = [
        {
          id: "history",
          role: "user",
          text: "already started",
          simulated: false,
        },
      ];
      q.state = { ...q.state };
      q.render();
    });
    await page
      .getByText("Worker configuration · single-provider mode", { exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Add worker", exact: true }),
    ).toBeDisabled();
    await expect(page.getByText(/Worker configuration is locked/)).toHaveCount(
      2,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
  } finally {
    await page.close();
  }
});

test("workspace chooser adds a selectable worker folder without rebinding the supervisor", async ({
  page,
}) => {
  await mount(page);
  try {
    await configureWorker(page, 1);
    await page.getByText("Add a worker workspace", { exact: true }).click();
    await page
      .getByRole("textbox", { name: "New worker workspace path" })
      .fill("/fixture/new-independent-folder");
    await page.getByRole("button", { name: "Choose / add workspace" }).click();
    await page
      .getByRole("combobox", { name: "Worker 1 workspace", exact: true })
      .selectOption("added");
    assert.equal(
      await page.evaluate(
        () =>
          (window as any).orchestrationFixture.state.conversations[0]
            .workspaceId,
      ),
      "parent",
    );
    assert.deepEqual(
      await page.evaluate(
        () =>
          (window as any).orchestrationFixture.calls.filter(
            (c: any) => c.name === "chooseWorkspace",
          )[0].args,
      ),
      ["/fixture/new-independent-folder"],
    );
  } finally {
    await page.close();
  }
});

function taskState() {
  const state = initialState();
  state.conversations[0].binding = {
    threadId: "parent-core-thread",
    sessionId: "parent-core-session",
    model: "fixture-supervisor",
    endpoint: "https://fixture.invalid",
    cwd: "/fixture/parent",
  };
  state.conversations[0].orchestration = {
    externalSharingConfirmed: true,
    workers: [
      {
        id: "worker_a",
        name: "Reader",
        selection: {
          providerId: "claude",
          model: "fixture-claude",
          effort: "low",
        },
        workspaceId: "w1",
        timeoutMs: 300000,
        contractHash: "a".repeat(64),
      },
      {
        id: "worker_b",
        name: "Reviewer",
        selection: {
          providerId: "axiom",
          model: "fixture-qwen",
          effort: "xhigh",
          context: 131072,
        },
        workspaceId: "w2",
        timeoutMs: 300000,
      },
    ],
  };
  state.delegations = ["a", "b", "cold", "done", "foreign"].map((id) => {
    const params = {
      threadId: `thread-${id}`,
      turnId: `turn-${id}`,
      itemId: `item-${id}`,
    };
    return {
      id: `task-${id}`,
      name: `Task ${id}`,
      workerId: id === "b" ? "worker_b" : "worker_a",
      parentConversationId:
        id === "foreign" ? "conversation-two" : "conversation-one",
      parentThreadId: "parent-core-thread",
      parentTurnId: "parent-turn",
      callId: `call-${id}`,
      task: `Assigned task ${id}`,
      status:
        id === "cold" ? "unknown" : id === "done" ? "completed" : "running",
      createdAt: 1000,
      updatedAt: 2000,
      deadlineAt: 301000,
      threadId: params.threadId,
      sessionId: `session-${id}`,
      turnId: params.turnId,
      result:
        id === "done"
          ? "Literal worker result <script>not executable</script>\n".repeat(
              100,
            )
          : "Partial worker output",
      ...(id === "cold"
        ? {
            error:
              "Coordinator restarted before settlement; outcome unknown; no replay",
          }
        : {}),
      approval: {
        approval: {
          id: "same-approval-id",
          params: {
            ...params,
            kind: "command",
            startedAtMs: 1000,
            command: `read scoped fixture ${id}`,
            cwd: `/fixture/${id}`,
            reason: "Needs your review",
          },
        },
        questions: [
          {
            id: "same-question-id",
            params: {
              ...params,
              isBlocking: true,
              autoResolutionMs: null,
              questions: [
                {
                  id: "choice",
                  header: "Approach",
                  question: "Choose a strategy",
                  isOther: true,
                  isSecret: false,
                  options: [
                    { label: "Inspect", description: "Read only" },
                    { label: "Modify", description: "Make changes" },
                  ],
                },
                {
                  id: "note",
                  header: "Private note",
                  question: "Fixture-only private note",
                  isOther: false,
                  isSecret: true,
                  options: null,
                },
              ],
            },
          },
        ],
      },
      tokenUsage:
        id === "done"
          ? {
              core: {
                total: { inputTokens: 123, outputTokens: 0, totalTokens: 123 },
              },
              axiom: [
                {
                  source: "axiom-response",
                  responseId: "response-done",
                  sessionId: "session-done",
                  threadId: "thread-done",
                  turnId: "turn-done",
                  inputTokens: 120,
                  outputTokens: 3,
                  thinkingTokens: 1,
                  totalTokens: 123,
                },
              ],
            }
          : undefined,
      items: [
        { id: `tool-${id}`, type: "commandExecution", status: "completed" },
      ],
    };
  });
  return state;
}

test("running workers expose approval and question controls scoped by task despite supervisor busy; failures retry safely", async ({
  page,
}) => {
  const { errors } = await mount(page, taskState());
  try {
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.busy = true;
      q.failures.delegationApprove = 1;
      q.failures.delegationAnswer = 1;
      q.render();
    });
    const a = page.getByRole("article", {
      name: "Delegated task Task a",
      exact: true,
    });
    const b = page.getByRole("article", {
      name: "Delegated task Task b",
      exact: true,
    });
    await a
      .getByRole("form", { name: "Worker approval same-approval-id" })
      .scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("orchestration-approval.png"),
      fullPage: true,
    });
    await a.getByRole("button", { name: "Deny this worker request" }).click();
    await expect(a.getByRole("alert")).toHaveText(
      "Controlled delegationApprove failure",
    );
    await a.getByRole("button", { name: "Deny this worker request" }).click();
    await expect(
      a.getByRole("button", { name: "Approve this worker request" }),
    ).toBeDisabled();
    await expect(
      b.getByRole("button", { name: "Approve this worker request" }),
    ).toBeEnabled();
    await b
      .getByRole("button", { name: "Approve this worker request" })
      .click();
    const question = a.getByRole("form", {
      name: "Worker question same-question-id",
    });
    await expect(
      question.getByRole("button", { name: "Send worker answers" }),
    ).toBeDisabled();
    await question.getByRole("radio", { name: /Inspect/ }).check();
    await question.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("orchestration-question.png"),
      fullPage: true,
    });
    await question
      .getByLabel("Worker answer: Private note")
      .fill("fixture private answer");
    await expect(
      question.getByLabel("Worker answer: Private note"),
    ).toHaveAttribute("type", "password");
    await question.getByRole("button", { name: "Send worker answers" }).click();
    await expect(question.getByRole("alert")).toHaveText(
      "Controlled delegationAnswer failure",
    );
    await question.getByRole("button", { name: "Send worker answers" }).click();
    await expect(question.getByRole("status")).toHaveText(
      "Answers accepted; waiting for the worker update.",
    );
    await expect(
      question.getByLabel("Worker answer: Private note"),
    ).toHaveValue("");
    const other = b.getByRole("form", {
      name: "Worker question same-question-id",
    });
    await expect(
      other.getByRole("radio", { name: /Inspect/ }),
    ).not.toBeChecked();
    await other.getByRole("radio", { name: "Custom answer" }).check();
    await other.getByLabel("Worker answer: Approach").fill("Custom strategy");
    await other
      .getByLabel("Worker answer: Private note")
      .fill("Another fixture note");
    await other.getByRole("button", { name: "Send worker answers" }).click();
    const calls = await page.evaluate(
      () => (window as any).orchestrationFixture.calls,
    );
    assert.deepEqual(
      calls
        .filter((c: any) => c.name === "delegationApprove")
        .map((c: any) => c.args),
      [
        ["conversation-one", "task-a", "same-approval-id", false],
        ["conversation-one", "task-a", "same-approval-id", false],
        ["conversation-one", "task-b", "same-approval-id", true],
      ],
    );
    assert.deepEqual(
      calls.filter((c: any) => c.name === "delegationAnswer").at(-1).args,
      [
        "conversation-one",
        "task-b",
        "same-question-id",
        { choice: ["Custom strategy"], note: ["Another fixture note"] },
      ],
    );
    await page.evaluate(() => {
      (window as any).orchestrationFixture.failures.delegationCancel = 1;
    });
    await a.getByRole("button", { name: "Cancel this worker task" }).click();
    await expect(a.getByRole("alert")).toHaveText(
      "Controlled delegationCancel failure",
    );
    await a.getByRole("button", { name: "Cancel this worker task" }).click();
    await expect(a.getByRole("heading")).toContainText("cancelled");
    await expect(
      a.getByRole("button", { name: "Cancel this worker task" }),
    ).toHaveCount(0);
    await expect(b.getByRole("heading")).toContainText("running");
    assert.deepEqual(
      await page.evaluate(
        () => (window as any).orchestrationFixture.calls.at(-1).args,
      ),
      ["conversation-one", "task-a"],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("unknown/crash state stays inert, real IDs and missing-vs-zero usage remain truthful, and long output scrolls", async ({
  page,
}) => {
  const { errors } = await mount(page, taskState());
  try {
    await expect(
      page.getByRole("article", { name: "Delegated task Task foreign" }),
    ).toHaveCount(0);
    const cold = page.getByRole("article", {
      name: "Delegated task Task cold",
      exact: true,
    });
    await expect(cold.getByRole("heading")).toContainText(
      "Unknown outcome — not known to be running",
    );
    await expect(cold.getByRole("button")).toHaveCount(0);
    await cold.getByText("Real identities and timing", { exact: true }).click();
    await expect(cold).toContainText("session-cold");
    await expect(cold).toContainText("parent-core-thread");
    await cold
      .getByText("Reported worker usage and activity", { exact: true })
      .click();
    await expect(
      cold.getByText("Core token usage not reported.", { exact: true }),
    ).toBeVisible();
    const done = page.getByRole("article", {
      name: "Delegated task Task done",
      exact: true,
    });
    await expect(done.getByRole("button")).toHaveCount(0);
    await expect(
      done.getByText("Worker result", {
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      done.getByRole("region", { name: "Supervisor review", exact: true }),
    ).toContainText("Pending");
    const full = done
      .locator("summary")
      .filter({ hasText: /^Full worker result/ });
    await full.focus();
    await page.keyboard.press("Enter");
    await expect(full.locator("..")).toHaveAttribute("open", "");
    await done
      .getByText("Reported worker usage and activity", { exact: true })
      .click();
    const total = done
      .locator(".orchestration-pair")
      .filter({ has: page.getByText("Output tokens", { exact: true }) })
      .first();
    await expect(total).toContainText("0");
    await expect(
      done.locator(".orchestration-pair").filter({
        has: page.getByText("Reasoning output tokens", { exact: true }),
      }),
    ).toContainText("Not reported");
    await done
      .getByText("Axiom response observations · 1", { exact: true })
      .click();
    await expect(done).toContainText("response-done");
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.equal(
      await page
        .getByRole("region", { name: "Orchestration controls and tasks" })
        .evaluate(
          (el) =>
            el.scrollHeight > el.clientHeight &&
            el.getBoundingClientRect().height <= innerHeight * 0.65,
        ),
      true,
    );
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.screenshot({
      path: test.info().outputPath("orchestration-tasks.png"),
      fullPage: true,
    });
    await page
      .getByText("Worker configuration · 2 saved", { exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Add worker", exact: true }),
    ).toBeDisabled();
    await expect(save(page)).toBeDisabled();
    assert.equal(
      await page.evaluate(
        () => (window as any).orchestrationFixture.calls.length,
      ),
      0,
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

type Review = NonNullable<AppState["delegations"][number]["review"]>;
function recordedReview(verdict: Review["verdict"]): Review {
  return {
    verdict,
    summary:
      verdict === "accepted"
        ? "The reported result meets the assigned checks. <script>literal review text</script>"
        : "Add the missing failure case, then submit a separate follow-up task.",
    parentThreadId: "original-review-parent-thread",
    parentTurnId: "original-review-parent-turn",
    callId: "original-review-call",
    at: Date.parse("2026-09-09T12:34:56Z"),
  };
}
function completedTaskState() {
  const state = taskState();
  state.delegations = state.delegations
    .filter((task) => task.id === "task-done")
    .map((task) => ({
      ...task,
      result: "Original completed worker result.",
      approval: undefined,
    }));
  return state;
}

for (const verdict of ["accepted", "changes_requested"] as const) {
  test(`supervisor review ${verdict} displays only the recorded decision and original identity, separate from worker completion`, async ({
    page,
  }) => {
    const state = completedTaskState();
    const review = recordedReview(verdict);
    state.delegations[0].review = review;
    const { errors } = await mount(page, state);
    try {
      const card = page.getByRole("article", {
        name: "Delegated task Task done",
      });
      await expect(card.getByRole("heading")).toHaveText(
        "Task done · completed",
      );
      await expect(
        card.getByText("Worker result", { exact: true }),
      ).toBeVisible();
      const section = card.getByRole("region", {
        name: "Supervisor review",
        exact: true,
      });
      await expect(
        section.getByText("Supervisor review:", { exact: false }).first(),
      ).toHaveText(
        `Supervisor review: ${verdict === "accepted" ? "Accepted" : "Changes requested"}`,
      );
      await expect(
        section.getByLabel("Review summary", { exact: true }),
      ).toHaveText(review.summary);
      const reviewedAt = await page.evaluate(
        (at) => new Date(at).toLocaleString(),
        review.at,
      );
      await expect(
        section.getByText(`Reviewed at: ${reviewedAt}`, { exact: true }),
      ).toBeVisible();
      await section
        .getByText("Original review identity", { exact: true })
        .click();
      for (const [label, value] of Object.entries({
        "Review call": review.callId,
        "Review parent Core thread": review.parentThreadId,
        "Review parent turn": review.parentTurnId,
      })) {
        await expect(
          section
            .locator(".orchestration-pair")
            .filter({
              has: page.getByText(label, { exact: true }),
            })
            .getByRole("definition"),
        ).toHaveText(value);
      }
      await expect(section).not.toContainText("Pending");
      await expect(section.locator("script")).toHaveCount(0);
      await expect(card.getByRole("button")).toHaveCount(0);
      await section.scrollIntoViewIfNeeded();
      await page.screenshot({
        path: test.info().outputPath(`orchestration-review-${verdict}.png`),
        fullPage: true,
      });
      await card
        .getByText("Real identities and timing", { exact: true })
        .click();
      await expect(
        card.getByRole("definition").filter({ hasText: /^call-done$/ }),
      ).toHaveCount(1);
      await expect(
        card.getByRole("definition").filter({ hasText: /^parent-turn$/ }),
      ).toHaveCount(1);
      assert.deepEqual(
        await page.evaluate(() => (window as any).orchestrationFixture.calls),
        [],
      );
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
}

test("completed unreviewed work stays pending; unfinished and unknown work do not acquire a review", async ({
  page,
}) => {
  const state = completedTaskState();
  const { errors } = await mount(page, state);
  try {
    const card = page.getByRole("article", {
      name: "Delegated task Task done",
    });
    const section = card.getByRole("region", {
      name: "Supervisor review",
      exact: true,
    });
    await expect(section).toContainText("Supervisor review: Pending");
    await expect(section).toContainText(
      "No supervisor review recorded. Worker completion is not acceptance.",
    );
    await expect(
      section.getByLabel("Review summary", { exact: true }),
    ).toHaveCount(0);
    await expect(section.getByText(/Reviewed at:/)).toHaveCount(0);
    await expect(section.locator("summary")).toHaveCount(0);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath("orchestration-review-pending.png"),
      fullPage: true,
    });
    for (const status of [
      "queued",
      "running",
      "failed",
      "cancelled",
      "unknown",
    ] as const) {
      await page.evaluate((status) => {
        const q = (window as any).orchestrationFixture;
        q.state = {
          ...q.state,
          delegations: q.state.delegations.map((task: any) => ({
            ...task,
            status,
          })),
        };
        q.render();
      }, status);
      await expect(card.getByRole("heading")).toContainText(
        status === "unknown" ? "Unknown outcome" : status,
      );
      await expect(section).toHaveCount(0);
      await expect(
        card.getByText("Reported output (not a completed result)", {
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        card.getByRole("button", { name: "Cancel this worker task" }),
      ).toHaveCount(status === "queued" || status === "running" ? 1 : 0);
    }
    assert.deepEqual(
      await page.evaluate(() => (window as any).orchestrationFixture.calls),
      [],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("follow-up links navigate to the prior task without merging output or inheriting acceptance", async ({
  page,
}) => {
  const state = completedTaskState();
  const prior = state.delegations[0];
  prior.id = 'task prior/#? "original"';
  prior.review = recordedReview("changes_requested");
  state.delegations.push({
    ...prior,
    id: "task-revision",
    name: "Follow-up",
    callId: "follow-up-delegation-call",
    result: "Separate follow-up worker result.",
    review: undefined,
    revisesTaskId: prior.id,
  });
  const { errors } = await mount(page, state);
  try {
    const original = page.getByRole("article", {
      name: "Delegated task Task done",
    });
    const followUp = page.getByRole("article", {
      name: "Delegated task Follow-up",
    });
    await expect(followUp.getByRole("heading")).toHaveText(
      "Follow-up · completed",
    );
    await expect(
      followUp.getByRole("region", { name: "Supervisor review", exact: true }),
    ).toContainText("Pending");
    await expect(followUp).toContainText(
      "Follow-up only; results are not automatically merged or accepted.",
    );
    await expect(followUp).not.toContainText(prior.result);
    await expect(original).not.toContainText(
      "Separate follow-up worker result.",
    );
    const link = followUp.getByRole("link", { name: prior.id, exact: true });
    await link.scrollIntoViewIfNeeded();
    // Trial click checks pointer hit testing; keyboard activation also checks
    // native fragment navigation/focus, including punctuation in durable IDs.
    await link.click({ trial: true });
    await link.focus();
    await page.screenshot({
      path: test.info().outputPath("orchestration-review-follow-up.png"),
      fullPage: true,
    });
    await page.keyboard.press("Enter");
    await expect(original).toBeFocused();
    await expect(original.getByRole("heading")).toBeInViewport();
    await expect(
      original.getByRole("region", { name: "Supervisor review", exact: true }),
    ).toContainText("Changes requested");
    assert.deepEqual(
      await page.evaluate(() => (window as any).orchestrationFixture.state),
      JSON.parse(JSON.stringify(state)),
    );
    assert.deepEqual(
      await page.evaluate(() => (window as any).orchestrationFixture.calls),
      [],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("follow-up IDs absent from the current conversation remain visible without a cross-conversation link", async ({
  page,
}) => {
  const state = completedTaskState();
  state.delegations[0].revisesTaskId = "foreign-task";
  state.delegations.push({
    ...state.delegations[0],
    id: "foreign-task",
    name: "Foreign task",
    parentConversationId: "conversation-two",
    result: "Other conversation output must stay out of this panel.",
  });
  const { errors } = await mount(page, state);
  try {
    const card = page.getByRole("article", {
      name: "Delegated task Task done",
    });
    for (const priorId of ["foreign-task", "missing-task"]) {
      await page.evaluate((priorId) => {
        const q = (window as any).orchestrationFixture;
        q.state.delegations[0].revisesTaskId = priorId;
        q.state = { ...q.state };
        q.render();
      }, priorId);
      await expect(card.locator(".orchestration-revision")).toContainText(
        priorId,
      );
      await expect(card).toContainText(
        "Prior task is not available in this conversation.",
      );
      await expect(card.getByRole("link")).toHaveCount(0);
    }
    await expect(page.getByRole("article")).toHaveCount(1);
    await expect(
      page.getByText("Other conversation output must stay out of this panel."),
    ).toHaveCount(0);
    assert.deepEqual(
      await page.evaluate(() => (window as any).orchestrationFixture.calls),
      [],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("long supervisor review summaries, original IDs and follow-up links have bounded keyboard-scrollable content", async ({
  page,
}) => {
  const state = completedTaskState();
  const task = state.delegations[0];
  task.review = {
    ...recordedReview("changes_requested"),
    summary:
      "<script>literal, not executable</script>\n" +
      "Review evidence line with an exact check.\n".repeat(400) +
      "FINAL REVIEW LINE",
    callId: "review-call-" + "c".repeat(4096),
    parentThreadId: "review-parent-thread-" + "t".repeat(4096),
    parentTurnId: "review-parent-turn-" + "u".repeat(4096),
  };
  task.revisesTaskId = "prior-task-" + "p".repeat(4096);
  state.delegations.push({
    ...task,
    id: task.revisesTaskId,
    name: "Long prior ID",
    review: undefined,
    revisesTaskId: undefined,
  });
  const { errors } = await mount(page, state);
  try {
    const card = page.getByRole("article", {
      name: "Delegated task Task done",
      exact: true,
    });
    const section = card.getByRole("region", {
      name: "Supervisor review",
      exact: true,
    });
    const summary = section.getByLabel("Review summary", { exact: true });
    await expect(summary).toHaveText(task.review.summary);
    await expect(section.locator("script")).toHaveCount(0);
    const content = page.getByRole("region", {
      name: "Orchestration controls and tasks",
      exact: true,
    });
    await summary.focus();
    const outerScroll = await content.evaluate((el) => el.scrollTop);
    await page.keyboard.press("End");
    await expect
      .poll(() =>
        summary.evaluate(
          (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
        ),
      )
      .toBe(true);
    assert.equal(await content.evaluate((el) => el.scrollTop), outerScroll);
    await expect(summary).toBeFocused();
    await summary.press("Home");
    await expect.poll(() => summary.evaluate((el) => el.scrollTop)).toBe(0);
    await section
      .getByText("Original review identity", { exact: true })
      .click();
    const identities = section.getByLabel("Original review identity", {
      exact: true,
    });
    await expect(identities.getByRole("definition")).toHaveText([
      task.review.callId,
      task.review.parentThreadId,
      task.review.parentTurnId,
    ]);
    const revision = card.locator(".orchestration-revision");
    await expect(revision.getByRole("link")).toHaveText(task.revisesTaskId);
    for (const [element, maxRem] of [
      [summary, 18],
      [identities, 12],
      [revision, 12],
    ] as const) {
      await element.focus();
      assert.equal(
        await element.evaluate((el, maxRem) => {
          const rem = parseFloat(
            getComputedStyle(document.documentElement).fontSize,
          );
          return (
            el.clientHeight > 0 &&
            el.scrollHeight > el.clientHeight &&
            el.getBoundingClientRect().height <= maxRem * rem + 1 &&
            el.scrollWidth <= el.clientWidth + 1
          );
        }, maxRem),
        true,
      );
      await element.press("End");
      await expect
        .poll(() =>
          element.evaluate(
            (el) => el.scrollTop + el.clientHeight >= el.scrollHeight - 1,
          ),
        )
        .toBe(true);
      await element.press("Home");
      await expect.poll(() => element.evaluate((el) => el.scrollTop)).toBe(0);
    }
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert.equal(
      await content.evaluate(
        (el) => el.getBoundingClientRect().height <= innerHeight * 0.65,
      ),
      true,
    );
    await section.evaluate((el) => el.scrollIntoView({ block: "start" }));
    await expect(summary).toBeInViewport();
    await page.screenshot({
      path: test.info().outputPath("orchestration-review-long-summary.png"),
      fullPage: true,
    });
    await identities.focus();
    await page.screenshot({
      path: test.info().outputPath("orchestration-review-long-identities.png"),
      fullPage: true,
    });
    assert.deepEqual(
      await page.evaluate(() => (window as any).orchestrationFixture.calls),
      [],
    );
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("malformed or mismatched worker requests never offer approval or answer controls", async ({
  page,
}) => {
  const state = taskState();
  (state.delegations[0].approval as any).approval.params.threadId =
    "foreign-thread";
  (state.delegations[0].approval as any).questions[0].params.turnId =
    "foreign-turn";
  state.delegations[1].approval = {
    approval: { id: "bad", params: null },
    questions: [null, { id: "incomplete" }],
  };
  await mount(page, state);
  try {
    for (const name of ["Task a", "Task b"]) {
      const card = page.getByRole("article", {
        name: `Delegated task ${name}`,
        exact: true,
      });
      await expect(card.getByRole("alert")).toContainText(
        "missing, invalid or mismatched identity",
      );
      await expect(
        card.getByRole("button", { name: "Approve this worker request" }),
      ).toHaveCount(0);
      await expect(
        card.getByRole("button", { name: "Send worker answers" }),
      ).toHaveCount(0);
      await expect(
        card.getByRole("button", { name: "Cancel this worker task" }),
      ).toBeEnabled();
    }
  } finally {
    await page.close();
  }
});

test("models with no reasoning support send no effort or context overrides; empty and invalid catalogs block saving", async ({
  page,
}) => {
  await mount(page);
  try {
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.catalogs.claude = [
        {
          id: "plain-model",
          context_window: null,
          context_window_options: [],
          reasoning_efforts: [],
        },
      ];
    });
    await page.getByRole("button", { name: "Add worker", exact: true }).click();
    await page
      .getByRole("combobox", { name: "Worker 1 provider", exact: true })
      .selectOption("claude");
    const modelSelect = page.getByRole("combobox", {
      name: "Worker 1 model",
      exact: true,
    });
    await modelSelect.selectOption("plain-model");
    const effort = page.getByRole("combobox", {
      name: "Worker 1 effort",
      exact: true,
    });
    await expect(effort).toBeDisabled();
    assert.deepEqual(await effort.locator("option").allTextContents(), [
      "Provider default (no effort override)",
    ]);
    await expect(
      page.getByText(/Model-managed context: window not reported/),
    ).toBeVisible();
    await page
      .getByRole("combobox", { name: "Worker 1 workspace", exact: true })
      .selectOption("w1");
    await consent(page).check();
    await expect(save(page)).toBeEnabled();
    // UI controls cannot create a free-form inference ID, even if a DOM option
    // is injected by a stale browser extension or an obsolete picker.
    await modelSelect.evaluate((el) => {
      const option = new Option("invented-model", "invented-model");
      el.append(option);
      (el as HTMLSelectElement).value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await expect(save(page)).toBeDisabled();
    await expect(modelSelect).toHaveValue("");
    assert.equal(
      await page.evaluate(() =>
        (window as any).orchestrationFixture.calls.some(
          (c: any) => c.name === "orchestrationConfigure",
        ),
      ),
      false,
    );
    await modelSelect.selectOption("plain-model");
    await consent(page).check();
    await save(page).click();
    assert.deepEqual(
      await page.evaluate(
        () =>
          (window as any).orchestrationFixture.calls.find(
            (c: any) => c.name === "orchestrationConfigure",
          ).args[1].workers[0].selection,
      ),
      { providerId: "claude", model: "plain-model" },
    );
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.catalogs.claude = [
        {
          id: "plain-model",
          context_window: null,
          context_window_options: [],
          reasoning_efforts: [],
          default_reasoning_effort: "invented-effort",
        },
      ];
    });
    await page
      .getByRole("button", { name: "Read / refresh model catalog" })
      .click();
    await expect(save(page)).toBeDisabled();
    await expect(
      page.getByText(
        "Model default reasoning effort is not advertised by this model",
        { exact: true },
      ),
    ).toHaveCount(2);
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.catalogs.claude = [];
    });
    await page
      .getByRole("button", { name: "Read / refresh model catalog" })
      .click();
    await expect(modelSelect).toBeDisabled();
    await expect(save(page)).toBeDisabled();
  } finally {
    await page.close();
  }
});

test("stale effort and provider changes invalidate consent and selections; active updates preserve unrelated worker drafts", async ({
  page,
}) => {
  await mount(page);
  try {
    await configureWorker(page, 1);
    await page
      .getByRole("combobox", { name: "Worker 1 effort", exact: true })
      .selectOption("high");
    await consent(page).check();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.catalogs.claude = [
        { ...q.catalogs.claude[0], reasoning_efforts: ["low"] },
      ];
    });
    await page
      .getByRole("button", { name: "Read / refresh model catalog" })
      .click();
    await expect(save(page)).toBeDisabled();
    await expect(
      page.getByText(
        "Selected reasoning effort is not advertised by this model",
        { exact: true },
      ),
    ).toHaveCount(2);
    await page
      .getByRole("combobox", { name: "Worker 1 effort", exact: true })
      .selectOption("low");
    await consent(page).check();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.state = {
        ...q.state,
        revision: 50,
        engine: { mode: "live", providerId: "axiom", model: "fixture-qwen" },
      };
      q.render();
    });
    await expect(consent(page)).not.toBeChecked();
    await expect(save(page)).toBeDisabled();
    await expect(
      page.getByRole("definition").filter({ hasText: /^max$/ }),
    ).toHaveCount(1);
    await expect(
      page.getByRole("combobox", { name: "Worker 1 effort", exact: true }),
    ).toHaveValue("low");
    await consent(page).check();
    await expect(save(page)).toBeEnabled();
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.state = { ...q.state, revision: 51 };
      q.render();
    });
    await expect(consent(page)).toBeChecked();
    await expect(
      page.getByRole("combobox", { name: "Worker 1 model", exact: true }),
    ).toHaveValue("fixture-claude");
    // Disabling a provider cannot leave its cached model saveable.
    await page.evaluate(() => {
      const q = (window as any).orchestrationFixture;
      q.state = {
        ...q.state,
        integrations: q.state.integrations.map((p: any) =>
          p.id === "claude" ? { ...p, enabled: false } : p,
        ),
      };
      q.render();
    });
    await expect(save(page)).toBeDisabled();
    await expect(
      page.getByRole("combobox", { name: "Worker 1 provider", exact: true }),
    ).toHaveValue("");
  } finally {
    await page.close();
  }
});
