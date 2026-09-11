import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { LocalService, type Host } from "../src/main/service";
import { LiveEngine } from "../src/engine/live-engine";
import type { EventEnvelope, Result } from "../src/shared/contracts";
import type { BusySubmission } from "../src/shared/user-preferences";
import { Store } from "../src/main/store";

const fixture = fileURLToPath(
  new URL("./fixtures/live-app-server.mjs", import.meta.url),
);
const value = <T>(r: Result<T>) => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > deadline) throw Error("CPU busy fixture timeout");
    await pause(5);
  }
}
async function setup(scenario = "busy-wait") {
  const dir = mkdtempSync(join(tmpdir(), "synora-busy-")),
    dbPath = join(dir, "state.sqlite"),
    log = join(dir, "rpc.jsonl");
  const host: Host = {
    capabilities: {
      platform: "web",
      transport: "local-http",
      nativeDialogs: false,
      terminal: false,
      embeddedBrowser: false,
      engine: "simulated",
      liveInference: false,
    },
    closeReady() {},
    chooseWorkspace: async () => null,
    importPreset: async () => null,
    exportPreset: async () => false,
    browser: {
      open: () => [],
      navigate() {},
      action: () => [],
      layout() {},
      list: () => [],
      dispose() {},
    },
  };
  const service = new LocalService(dbPath, host, () => {}, 1, {
    disabledReason: "CPU fixture",
  });
  const workspace = service.store.addWorkspace(dir, "Owned fixture");
  service.store.integration({
    id: "fixture",
    kind: "provider",
    providerType: "axiom",
    name: "CPU fixture",
    endpoint: "http://127.0.0.1:9999/codex/v1",
    enabled: true,
    auth: "none",
    tools: [],
  });
  const preset = service.store.preset({
    schema: "synora.bot.v1",
    name: "Creation Bot",
    description: "",
    instructions: "IMMUTABLE_BOT_INSTRUCTIONS",
    kind: "coding",
    profile: "max",
    context: 1048576,
    connectorIds: ["unmounted"],
    enabled: true,
  }).presets[0];
  service.store.preferences({ defaultBotId: preset.id });
  const conversation = service.store.conversation(workspace.id);
  const config = {
    mode: "live" as const,
    providerId: "fixture",
    model: "qwen3.8-27b-nvfp4",
  };
  // Select the production context/binding/persistence hooks, but explicitly
  // disable the persistent executor and replace prepare before any start.
  const engine: LiveEngine = (service as any).makeEngine(config, 0, {
    sink: (event: EventEnvelope) => (service as any).persistEngine(event),
  });
  const prepared: Array<{ profile: string; context: number | null }> = [];
  (engine as any).prepare = async (options: {
    profile: string;
    context: number | null;
  }) => {
    prepared.push({ profile: options.profile, context: options.context });
    return {
      executable: process.execPath,
      cwd: dir,
      env: { ...process.env, SYNORA_FIXTURE_RPC_LOG: log },
      args: [fixture, scenario],
      models: [
        {
          id: config.model,
          context_window: 262144,
          context_window_options: [262144],
          reasoning_efforts: ["ultra-fast"],
        },
      ],
    };
  };
  await service.engine.dispose();
  service.engine = engine;
  const calls = (): Array<{ method: string; params: any }> => {
    try {
      return readFileSync(log, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((v) => JSON.parse(v));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
  };
  const busy = (behavior: BusySubmission["behavior"]): BusySubmission => ({
    behavior,
    expectedThreadId: engine.snapshot().threadId!,
    expectedTurnId: engine.snapshot().turnId!,
  });
  return {
    dir,
    dbPath,
    service,
    engine,
    conversation,
    preset,
    calls,
    prepared,
    busy,
    owner: () =>
      service.store.read().conversations.find((c) => c.id === conversation.id)!,
    start: () =>
      service.api.engineStart(conversation.id, "first", "text").then(value),
    close: async () => {
      await service.dispose();
      rmSync(dir, { recursive: true });
    },
  };
}
test("Production context sends the creation Bot to Core without forcing its Axiom profile, context or connectors", async () => {
  const t = await setup();
  try {
    value(
      await t.service.api.preferences({
        permission: "full",
        defaultBotId: null,
      }),
    );
    const { id, ...preset } = t.preset;
    t.service.store.preset({ ...preset, instructions: "CHANGED_LATER" }, id);
    await t.start();
    const start = t.calls().find((c) => c.method === "thread/start")!;
    assert.match(
      start.params.developerInstructions,
      /IMMUTABLE_BOT_INSTRUCTIONS/,
    );
    assert.doesNotMatch(start.params.developerInstructions, /CHANGED_LATER/);
    assert.equal(start.params.approvalPolicy, "on-request");
    assert.equal(start.params.sandbox, "workspace-write");
    assert.equal(start.params.config.model_reasoning_effort, "ultra-fast");
    assert.equal(start.params.config.model_context_window, 262144);
    assert.equal(start.params.dynamicTools, undefined);
    assert.deepEqual(t.prepared, [{ profile: "ultra-fast", context: 262144 }]);
    assert.equal(t.owner().defaults!.permission, "ask");
  } finally {
    await t.close();
  }
});
test("Busy steer uses the existing Core thread/session/turn and persists its actual user item", async () => {
  const t = await setup();
  try {
    const first = await t.start();
    value(await t.service.api.saveDraft(t.conversation.id, "steered input"));
    const response = value(
      await t.service.api.engineStart(
        t.conversation.id,
        "steered input",
        "text",
        t.busy("steer"),
      ),
    );
    assert.equal(response.threadId, first.threadId);
    assert.equal(response.sessionId, first.sessionId);
    assert.equal(response.turnId, first.turnId);
    await until(() =>
      t.owner().messages.some((m) => m.text === "steered input"),
    );
    assert.equal(t.owner().draft, "");
    const requests = t.calls();
    assert.equal(requests.filter((c) => c.method === "turn/start").length, 1);
    const steer = requests.find((c) => c.method === "turn/steer")!;
    assert.equal(steer.params.expectedTurnId, first.turnId);
    assert.equal(steer.params.threadId, first.threadId);
    assert.equal(
      t.owner().messages.find((m) => m.text === "steered input")!.id,
      steer.params.clientUserMessageId,
    );
    assert.equal(requests.filter((c) => c.method === "thread/start").length, 1);
  } finally {
    await t.close();
  }
});
test("Wrong conversation, stale turn and missing binding fail before a busy RPC", async () => {
  const t = await setup();
  try {
    await t.start();
    for (const [id, busy] of [
      ["foreign", t.busy("steer")],
      [t.conversation.id, { ...t.busy("steer"), expectedTurnId: "old" }],
    ] as const)
      assert.equal(
        (await t.service.api.engineStart(id, "no send", "text", busy)).ok,
        false,
      );
    t.service.store.update((s) => {
      s.conversations[0].binding!.sessionId = "foreign";
    });
    assert.equal(
      (
        await t.service.api.engineStart(
          t.conversation.id,
          "no send",
          "text",
          t.busy("queue"),
        )
      ).ok,
      false,
    );
    assert.equal(t.calls().filter((c) => c.method === "turn/steer").length, 0);
  } finally {
    await t.close();
  }
});
for (const scenario of ["busy-reject", "busy-wrong-id"])
  test(`${scenario}: Core rejection/mismatched acknowledgement never starts a replacement turn`, async () => {
    const t = await setup(scenario);
    try {
      const first = await t.start();
      const response = await t.service.api.engineStart(
        t.conversation.id,
        "no replacement",
        "text",
        t.busy("steer"),
      );
      assert.equal(response.ok, false);
      assert.equal(t.engine.snapshot().turnId, first.turnId);
      assert.equal(
        t.calls().filter((c) => c.method === "turn/start").length,
        1,
      );
    } finally {
      await t.close();
    }
  });
test("Cancellation racing a steer acknowledgement cannot mutate turn identity or silently replay input", async () => {
  const t = await setup("busy-late");
  try {
    const first = await t.start();
    const pending = t.service.api.engineStart(
      t.conversation.id,
      "racing steer",
      "text",
      t.busy("steer"),
    );
    await until(() => t.calls().some((c) => c.method === "turn/steer"));
    value(await t.service.api.engineCancel());
    assert.equal((await pending).ok, false);
    assert.equal(t.engine.snapshot().turnId, first.turnId);
    assert.equal(t.engine.snapshot().status, "interrupted");
    assert.equal(t.calls().filter((c) => c.method === "turn/start").length, 1);
  } finally {
    await t.close();
  }
});
test("Queued messages dispatch FIFO only after success, with new turns in the original thread/session", async () => {
  const t = await setup("busy-queue");
  try {
    const first = await t.start();
    for (const text of ["queued one", "queued two"])
      value(
        await t.service.api.engineStart(
          t.conversation.id,
          text,
          "text",
          t.busy("queue"),
        ),
      );
    assert.equal(t.owner().queuedMessages!.length, 2);
    assert.equal(t.calls().filter((c) => c.method === "turn/start").length, 1);
    await until(
      () =>
        t.calls().filter((c) => c.method === "turn/start").length === 3 &&
        t.engine.snapshot().status === "completed",
    );
    assert.equal(t.owner().queuedMessages!.length, 0);
    assert.deepEqual(
      t
        .calls()
        .filter((c) => c.method === "turn/start")
        .map((c) => c.params.input[0].text),
      ["first", "queued one", "queued two"],
    );
    assert.equal(t.engine.snapshot().threadId, first.threadId);
    assert.equal(t.engine.snapshot().sessionId, first.sessionId);
    assert.match(t.engine.snapshot().turnId!, /^busy-turn-\d+-3$/);
    assert.notEqual(t.engine.snapshot().turnId, first.turnId);
    assert.equal(
      t.calls().filter((c) => c.method === "thread/start").length,
      1,
    );
  } finally {
    await t.close();
  }
});
test("Cancel holds queued text, preserves later drafts, and cold recovery cannot replay it", async () => {
  const t = await setup("busy-queue");
  try {
    await t.start();
    value(await t.service.api.saveDraft(t.conversation.id, "queued"));
    value(
      await t.service.api.engineStart(
        t.conversation.id,
        "queued",
        "text",
        t.busy("queue"),
      ),
    );
    value(await t.service.api.saveDraft(t.conversation.id, "newer draft"));
    value(await t.service.api.engineCancel());
    await pause(200);
    assert.equal(t.owner().draft, "newer draft");
    assert.equal(t.owner().queuedMessages![0].status, "held");
    assert.equal(t.calls().filter((c) => c.method === "turn/start").length, 1);
    // Simulate a persisted in-flight queue at crash, without running a process.
    t.service.store.update((s) => {
      s.conversations[0].queuedMessages![0].status = "dispatching";
    });
    const snapshot = t.service.store.read();
    const coldPath = join(t.dir, "cold.sqlite"),
      seed = new Store(coldPath);
    seed.restoreSnapshot(snapshot);
    seed.close();
    const cold = new Store(coldPath);
    try {
      assert.equal(
        cold.read().conversations[0].queuedMessages![0].status,
        "held",
      );
    } finally {
      cold.close();
    }
  } finally {
    await t.close();
  }
});
test("Disconnect, mismatched completion and changed binding hold the queue without dispatch", async () => {
  for (const fault of ["disconnect", "turn", "binding"] as const) {
    const t = await setup();
    try {
      const first = await t.start();
      // Drain real turn/started + user-item events before injecting a synthetic
      // terminal state; they intentionally arrive after the RPC acknowledgement.
      await until(() => t.owner().messages.length > 0);
      value(
        await t.service.api.engineStart(
          t.conversation.id,
          "held",
          "text",
          t.busy("queue"),
        ),
      );
      if (fault === "binding")
        t.service.store.update((s) => {
          s.conversations[0].binding!.sessionId = "other";
        });
      (t.engine as any).state = {
        ...first,
        status: "completed",
        ...(fault === "disconnect"
          ? { connection: "disconnected" }
          : fault === "turn"
            ? { turnId: "other" }
            : {}),
      };
      (t.service as any).scheduleQueuedMessages();
      await until(() => t.owner().queuedMessages![0].status === "held");
      assert.equal(
        t.calls().filter((c) => c.method === "turn/start").length,
        1,
      );
    } finally {
      await t.close();
    }
  }
});
test("Independently authored identical text cannot consume held entries; explicit discard preserves the loaded draft", async () => {
  const t = await setup();
  try {
    await t.start();
    await until(() => t.owner().messages.length > 0);
    value(
      await t.service.api.engineStart(
        t.conversation.id,
        "resend after review",
        "text",
        t.busy("queue"),
      ),
    );
    value(await t.service.api.engineCancel());
    assert.equal(t.owner().queuedMessages![0].status, "held");
    const held = structuredClone(t.owner().queuedMessages!);
    value(
      await t.service.api.engineStart(
        t.conversation.id,
        "resend after review",
        "text",
      ),
    );
    await until(() =>
      t.owner().messages.some((m) => m.text === "resend after review"),
    );
    assert.deepEqual(t.owner().queuedMessages, held);
    assert.equal(t.calls().filter((c) => c.method === "turn/start").length, 2);
    value(await t.service.api.saveDraft(t.conversation.id, held[0].text));
    value(
      await t.service.api.discardQueuedMessage(t.conversation.id, held[0].id),
    );
    assert.deepEqual(t.owner().queuedMessages, []);
    assert.equal(t.owner().draft, held[0].text);
  } finally {
    await t.close();
  }
});
test("Explicit discard removes only the requested queued or held identity, without sending or changing drafts", async () => {
  const t = await setup();
  try {
    await t.start();
    await until(() => t.owner().messages.length > 0);
    for (let n = 0; n < 3; n++)
      value(
        await t.service.api.engineStart(
          t.conversation.id,
          "same unsent text",
          "text",
          t.busy("queue"),
        ),
      );
    const before = t.owner().queuedMessages!;
    value(await t.service.api.saveDraft(t.conversation.id, "unrelated draft"));
    const state = value(
      await t.service.invoke("discardQueuedMessage", [
        t.conversation.id,
        before[1].id,
      ]),
    ) as import("../src/shared/contracts").AppState;
    assert.deepEqual(
      state.conversations
        .find((c) => c.id === t.conversation.id)!
        .queuedMessages!.map((m) => m.id),
      [before[0].id, before[2].id],
    );
    assert.equal(t.owner().draft, "unrelated draft");
    value(await t.service.api.engineCancel());
    assert.ok(t.owner().queuedMessages!.every((m) => m.status === "held"));
    value(
      await t.service.api.discardQueuedMessage(t.conversation.id, before[0].id),
    );
    assert.deepEqual(
      t.owner().queuedMessages!.map((m) => m.id),
      [before[2].id],
    );
    assert.equal(t.owner().draft, "unrelated draft");
    assert.equal(t.calls().filter((c) => c.method === "turn/start").length, 1);
    const coldPath = join(t.dir, "discarded.sqlite"),
      seed = new Store(coldPath);
    seed.restoreSnapshot(t.service.store.read());
    seed.close();
    const cold = new Store(coldPath);
    try {
      assert.deepEqual(
        cold
          .read()
          .conversations.find((c) => c.id === t.conversation.id)!
          .queuedMessages!.map((m) => m.id),
        [before[2].id],
      );
    } finally {
      cold.close();
    }
  } finally {
    await t.close();
  }
});
test("Discard rejects foreign, missing, malformed and stale identities without any state mutation", async () => {
  const t = await setup();
  try {
    await t.start();
    await until(() => t.owner().messages.length > 0);
    value(
      await t.service.api.engineStart(
        t.conversation.id,
        "keep",
        "text",
        t.busy("queue"),
      ),
    );
    const message = t.owner().queuedMessages![0];
    const other = t.service.store.conversation(t.conversation.workspaceId);
    const baseline = t.service.store.read();
    for (const args of [
      [other.id, message.id],
      [randomUUID(), message.id],
      [t.conversation.id, randomUUID()],
      [t.conversation.id, ""],
      [t.conversation.id],
      [t.conversation.id, message.id, true],
    ]) {
      assert.equal(
        (await t.service.invoke("discardQueuedMessage", args)).ok,
        false,
      );
      assert.deepEqual(t.service.store.read(), baseline);
    }
    value(
      await t.service.api.discardQueuedMessage(t.conversation.id, message.id),
    );
    const discarded = t.service.store.read();
    assert.equal(
      (await t.service.api.discardQueuedMessage(t.conversation.id, message.id))
        .ok,
      false,
    );
    assert.deepEqual(t.service.store.read(), discarded);
  } finally {
    await t.close();
  }
});
test("Discard winning during async queue preparation prevents stale captured input from dispatching", async (ctx) => {
  const t = await setup();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let preparing = false;
  let draining: Promise<void> | undefined;
  try {
    await t.start();
    await until(() => t.owner().messages.length > 0);
    value(
      await t.service.api.engineStart(
        t.conversation.id,
        "discard before claim",
        "text",
        t.busy("queue"),
      ),
    );
    const message = t.owner().queuedMessages![0];
    t.service.store.update((s) => {
      s.conversations.find((c) => c.id === t.conversation.id)!.orchestration = {
        externalSharingConfirmed: true,
        workers: [
          {
            id: "worker",
            name: "CPU worker",
            workspaceId: t.conversation.workspaceId!,
            timeoutMs: 1000,
            selection: {
              providerId: "fixture",
              model: "qwen3.8-27b-nvfp4",
              effort: "ultra-fast",
              context: 262144,
            },
          },
        ],
      };
    });
    ctx.mock.method(t.service as any, "validateWorkerPlan", async () => {
      preparing = true;
      await gate;
    });
    // A deterministic terminal snapshot isolates the worker-validation await.
    (t.engine as any).state = { ...t.engine.snapshot(), status: "completed" };
    draining = (t.service as any).drainQueuedMessage();
    await until(() => preparing);
    value(
      await t.service.api.discardQueuedMessage(t.conversation.id, message.id),
    );
    release();
    await draining;
    await pause(60);
    assert.deepEqual(t.owner().queuedMessages, []);
    assert.equal(t.calls().filter((c) => c.method === "turn/start").length, 1);
  } finally {
    release();
    await draining;
    ctx.mock.restoreAll();
    await t.close();
  }
});
test("Dispatch winning the race rejects discard and sends the claimed queue identity exactly once", async (ctx) => {
  const t = await setup("busy-queue");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let dispatching = false;
  try {
    await t.start();
    const start = t.engine.start.bind(t.engine);
    ctx.mock.method(
      t.engine,
      "start",
      async (...args: Parameters<LiveEngine["start"]>) => {
        dispatching = true;
        await gate;
        return start(...args);
      },
    );
    value(
      await t.service.api.engineStart(
        t.conversation.id,
        "already claimed",
        "text",
        t.busy("queue"),
      ),
    );
    const message = t.owner().queuedMessages![0];
    await until(() => dispatching);
    assert.equal(t.owner().queuedMessages![0].status, "dispatching");
    const state = t.service.store.read();
    const response = await t.service.api.discardQueuedMessage(
      t.conversation.id,
      message.id,
    );
    assert.equal(response.ok, false);
    if (!response.ok)
      assert.match(response.error.message, /already dispatching/);
    assert.deepEqual(t.service.store.read(), state);
    release();
    await until(
      () =>
        !t.owner().queuedMessages!.length &&
        t.engine.snapshot().status === "completed",
    );
    assert.deepEqual(
      t
        .calls()
        .filter((c) => c.method === "turn/start")
        .map((c) => c.params.input[0].text),
      ["first", "already claimed"],
    );
  } finally {
    release();
    await until(() => !(t.service as any).drainingQueue);
    ctx.mock.restoreAll();
    await t.close();
  }
});
test("Empty Bot connector selection preserves all mounted integrations and Tutor tools; Standard adds no instructions", async () => {
  const t = await setup();
  try {
    const { id, ...preset } = t.preset;
    t.service.store.preset({ ...preset, connectorIds: [] }, id);
    t.service.store.integration({
      id: "mounted",
      name: "Mounted MCP",
      kind: "mcp",
      executor: "http-mcp",
      endpoint: "http://127.0.0.1:9998/mcp",
      enabled: true,
      auth: "none",
      tools: [],
    });
    const c = t.service.store.conversation(t.conversation.workspaceId);
    t.service.store.update((s) => {
      s.conversations.find((v) => v.id === c.id)!.orchestration = {
        externalSharingConfirmed: true,
        workers: [
          {
            id: "worker",
            name: "Configured worker",
            workspaceId: t.conversation.workspaceId!,
            timeoutMs: 1000,
            selection: {
              providerId: "fixture",
              model: "qwen3.8-27b-nvfp4",
              effort: "ultra-fast",
              context: 262144,
            },
          },
        ],
      };
    });
    const context = (t.engine as any).options.context(c.id);
    assert.deepEqual(
      context.integrations.map((v: { id: string }) => v.id),
      ["mounted"],
    );
    assert.ok(
      context.hostTools.catalog.some(
        (v: { name: string }) => v.name === "synora_delegate",
      ),
    );
    assert.match(context.botInstructions, /IMMUTABLE_BOT_INSTRUCTIONS/);
    value(await t.service.api.preferences({ defaultBotId: null }));
    const standard = t.service.store.conversation(t.conversation.workspaceId);
    const direct = (t.engine as any).options.context(standard.id);
    assert.equal(direct.botInstructions, undefined);
    assert.deepEqual(direct.integrations, context.integrations);
    assert.equal(direct.profile, "ultra-fast");
    assert.equal(direct.context, 262144);
    assert.equal(direct.permission, "ask");
    assert.equal(t.calls().length, 0);
  } finally {
    await t.close();
  }
});
