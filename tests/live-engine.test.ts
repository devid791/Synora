import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { LiveEngine, type LiveOptions } from "../src/engine/live-engine";
import {
  axiomEndpoint,
  appServerEnvironment,
} from "../src/engine/axiom-process";
import {
  parseNotification,
  parseResponse,
} from "../src/engine/protocol-validation";
import { emptyEngine, reduceEngine } from "../src/renderer/engine-state";
import type { EventEnvelope, EngineBinding } from "../src/shared/contracts";
const fixture = fileURLToPath(
  new URL("./fixtures/live-app-server.mjs", import.meta.url),
);
const endpoint = "http://127.0.0.1:9999/codex/v1";
const models: Awaited<
  ReturnType<typeof import("../src/engine/axiom-process").prepareAxiomProcess>
>["models"] = [
  {
    id: "qwen3.8-27b-nvfp4",
    context_window: 262144,
    context_window_options: [262144],
    reasoning_efforts: ["ultra-fast"],
  },
];
async function until(fn: () => boolean) {
  const limit = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > limit) throw new Error("Fixture timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function setup(
  scenario = "text",
  patch: Partial<LiveOptions> = {},
  prepare?: typeof import("../src/engine/axiom-process").prepareAxiomProcess,
) {
  const events: EventEnvelope[] = [];
  let binding: EngineBinding | undefined;
  const engine = new LiveEngine(
    {
      executable: process.execPath,
      stateDirectory: "/synora-fixture",
      endpoint,
      model: "qwen3.8-27b-nvfp4",
      context: () => ({
        cwd: "/synora-fixture",
        profile: "ultra-fast",
        context: 262144,
        binding,
      }),
      bind: (_id, b) => {
        binding = b;
      },
      sink: (e) => events.push(e),
      ...patch,
    },
    prepare ??
      (async (options) => ({
        executable: process.execPath,
        cwd: process.cwd(),
        env: process.env,
        args: [fixture, scenario, (options as typeof options & { permission?: string }).permission ?? "ask"],
        models,
      })),
  );
  return { engine, events, binding: () => binding };
}
for (const scenario of ["restore-precise-times", "restore-missing-times", "restore-empty", "restore-incomplete"])
  test(`${scenario}: restoring history clears unrelated timing and uses only original Core measurements`, async () => {
    const t = setup(scenario);
    try {
      await t.engine.start("first", "fixture", "text");
      await until(() => t.engine.snapshot().status === "completed");
      assert.ok(t.engine.snapshot().firstDeltaAt);
      const restored = await t.engine.restore("other");
      assert.equal(restored.firstDeltaAt, undefined);
      assert.deepEqual(restored.questions, []);
      assert.equal(restored.startedAt, scenario === "restore-precise-times" ? 100000
        : scenario === "restore-incomplete" ? 1000 : undefined);
      assert.equal(restored.completedAt, scenario === "restore-precise-times" ? 108356 : undefined);
      assert.equal(restored.status, scenario === "restore-incomplete" ? "disconnected"
        : scenario === "restore-empty" ? "idle" : "completed");
    } finally { await t.engine.dispose(); }
  });
test("Real protocol usage events retain counters across two turns without duplication or cross-thread leakage", async () => {
  const t = setup("usage");
  try {
    await t.engine.start("owned", "one", "text");
    await until(() => t.engine.snapshot().status === "completed");
    const first = t.engine.snapshot().usage!;
    assert.equal(first.value.total.totalTokens, 100);
    assert.equal(first.turn?.totalTokens, 100);
    const pending = t.engine.start("owned", "two", "text");
    assert.equal(t.engine.snapshot().usage?.value.total.totalTokens, 100);
    await pending;
    await until(() => t.engine.snapshot().status === "completed");
    const second = t.engine.snapshot().usage!;
    assert.equal(second.value.total.totalTokens, 200);
    assert.equal(second.value.last.totalTokens, 100);
    assert.equal(second.turn?.totalTokens, 100);
    assert.equal(second.turnId, "usage-turn-2");
  } finally { await t.engine.dispose(); }
});
test("Explicit ask/full/auto/ask changes resume one original Core thread with exact policy acknowledgement", async () => {
  let binding: EngineBinding | undefined, permission: import("../src/shared/permission-mode").PermissionMode = "ask";
  const t = setup("permissions-change", {
    context: () => ({ cwd: "/synora-fixture", profile: "ultra-fast", context: 262144, permission, binding }),
    bind: (_id, value) => { binding = value; },
  });
  let original: EngineBinding | undefined;
  try {
    for (const next of ["ask", "full", "auto-review", "ask"] as const) {
      permission = next;
      await t.engine.start("owned", `Turn ${next}`, "text");
      await until(() => t.engine.snapshot().status === "completed");
      original ??= binding;
      assert.equal(binding?.threadId, original?.threadId);
      assert.equal(binding?.sessionId, original?.sessionId);
      assert.equal(binding?.permission ?? "ask", next);
    }
  } finally { await t.engine.dispose(); }
});
test("Rejected permission change keeps the last confirmed binding and never starts the new turn", async () => {
  let binding: EngineBinding | undefined, permission: import("../src/shared/permission-mode").PermissionMode = "ask";
  const t = setup("permissions-change-rejected", {
    context: () => ({ cwd: "/synora-fixture", profile: "ultra-fast", context: 262144, permission, binding }),
    bind: (_id, value) => { binding = value; },
  });
  try {
    await t.engine.start("owned", "Initial ask", "text");
    await until(() => t.engine.snapshot().status === "completed");
    const original = structuredClone(binding), before = t.events.length;
    permission = "full";
    await assert.rejects(t.engine.start("owned", "Not dispatched", "text"), /did not confirm the requested permissions/);
    assert.deepEqual(binding, original);
    assert.equal(t.events.slice(before).some(e => e.event.kind === "protocol" && e.event.payload.method === "turn/started"), false);
  } finally { await t.engine.dispose(); }
});
for (const permission of ["auto-review", "full"] as const)
  test(`${permission} is acknowledged exactly by Core and bound durably`, async () => {
    let binding: EngineBinding | undefined;
    const t = setup(permission === "full" ? "permissions-full" : "permissions-auto", {
      context: () => ({ cwd: "/synora-fixture", profile: "ultra-fast", context: 262144, permission, binding }),
      bind: (_id, value) => { binding = value; },
    });
    try {
      await t.engine.start("owned", "one", "text");
      await until(() => t.engine.snapshot().status === "completed");
      assert.equal(binding?.permission, permission);
      await t.engine.start("owned", "two", "text");
      await until(() => t.engine.snapshot().status === "completed");
      assert.equal(binding?.permission, permission);
    } finally { await t.engine.dispose(); }
  });
test("Compaction acknowledges early, retains original identity, ignores stale turns and completes only on Core lifecycle", async () => {
  const t = setup("compact");
  try {
    await assert.rejects(
      t.engine.compact("owned"),
      /Start a live conversation/,
    );
    await t.engine.start("owned", "fixture", "text");
    await until(() => t.engine.snapshot().status === "completed");
    const original = t.engine.snapshot();
    const ack = await t.engine.compact("owned");
    assert.equal(ack.status, "running");
    assert.equal(ack.firstDeltaAt, undefined);
    await assert.rejects(
      t.engine.start("owned", "overlap", "text"),
      /already active/,
    );
    await until(() => t.engine.snapshot().status === "completed");
    const done = t.engine.snapshot();
    assert.equal(done.sessionId, original.sessionId);
    assert.equal(done.threadId, original.threadId);
    assert.equal(done.turnId, "compact-turn");
    assert.equal(done.compactions?.[0].status, "completed");
    assert.equal(
      done.items.some((i) => i.type === "agentMessage"),
      false,
    );
    assert.equal(done.firstDeltaAt, undefined);
    const ui = t.events.reduce(reduceEngine, emptyEngine);
    assert.equal(ui.compactions?.[0].status, "completed");
    assert.equal(ui.turnId, done.turnId);
  } finally {
    await t.engine.dispose();
  }
});
test("Automatic compaction has the same event contract, without manual compact RPC", async () => {
  const t = setup("compact-auto");
  try {
    await t.engine.start("owned", "fixture", "text");
    await until(() => t.engine.snapshot().status === "completed");
    assert.equal(
      t.engine.snapshot().compactions?.[0].id,
      "automatic-compact-item",
    );
    assert.equal(t.engine.snapshot().compactions?.[0].status, "completed");
    assert.ok(
      t.engine
        .snapshot()
        .items.some(
          (i) => i.type === "agentMessage" && i.text === "FIXTURE_OK",
        ),
    );
  } finally {
    await t.engine.dispose();
  }
});
test("Compaction cancellation, failure, incomplete lifecycle and missing-start deadline never become compaction success", async () => {
  for (const scenario of [
    "compact-wait",
    "compact-failed",
    "compact-missing-item-end",
    "compact-no-start",
    "compact-invalid",
    "compact-impossible-terminal",
  ]) {
    const t = setup(scenario, { turnDeadlineMs: 500 });
    try {
      await t.engine.start("owned", "fixture", "text");
      await until(() => t.engine.snapshot().status === "completed");
      if (scenario === "compact-invalid") {
        await assert.rejects(
          t.engine.compact("owned"),
          /Invalid App Server compact/,
        );
      } else {
        await t.engine.compact("owned");
        if (scenario === "compact-wait") {
          await until(() => t.engine.snapshot().turnId === "compact-turn");
          await t.engine.cancel();
        }
        await until(
          () => !["running", "waiting"].includes(t.engine.snapshot().status),
        );
      }
      const s = t.engine.snapshot();
      assert.ok(
        !s.compactions?.some((c) => c.status === "completed"),
        scenario,
      );
      if (scenario === "compact-missing-item-end")
        assert.equal(s.compactions?.[0].status, "unknown");
      else if (scenario === "compact-wait")
        assert.equal(s.compactions?.[0].status, "interrupted");
      else assert.equal(s.status, "failed");
      if (scenario === "compact-no-start")
        assert.equal(s.error?.code, "TURN_DEADLINE");
    } finally {
      await t.engine.dispose();
    }
  }
});
test("Image-only turn uses exact localImage input; unadvertised vision fails before inference", async () => {
  for (const supported of [false, true]) {
    const t = setup("images", {}, async () => ({
      executable: process.execPath,
      cwd: process.cwd(),
      env: process.env,
      args: [fixture, "images"],
      models: models.map((m) => ({
        ...m,
        input_modalities: supported ? ["text", "image"] : ["text"],
      })),
    }));
    try {
      const request = t.engine.start("owned", "", "text", [
        { type: "localImage", path: "/synora-fixture/owned.png" },
      ]);
      if (!supported) {
        await assert.rejects(request, /does not advertise image/);
        assert.equal(
          t.events.some(
            (e) =>
              e.event.kind === "protocol" &&
              e.event.payload.method === "turn/started",
          ),
          false,
        );
      } else {
        await request;
        await until(() => t.engine.snapshot().status === "completed");
        const user = t.engine
          .snapshot()
          .items.find((i) => i.type === "userMessage");
        assert.deepEqual(user?.type === "userMessage" && user.content, [
          { type: "localImage", path: "/synora-fixture/owned.png" },
        ]);
      }
    } finally {
      await t.engine.dispose();
    }
  }
});
test("Credential or executor invalidation recreates the owned process without losing session identity", async () => {
  for (const provider of [undefined, "openai", "synora_xai"] as const) {
    let credential: string | undefined = "first-fixture-key";
    const prepared: string[] = [],
      closed: string[] = [];
    const scenario = provider === "openai" ? "openai" : "text";
    const t = setup(
      scenario,
      {
        provider,
        model: provider === "openai" ? "wire-fixture" : "qwen3.8-27b-nvfp4",
        authorization: async () => credential,
        context: () => ({
          cwd: "/synora-fixture",
          profile: provider ? "high" : "ultra-fast",
          context: provider ? null : 262144,
          binding: t.binding(),
        }),
      },
      async (options) => {
        const captured = await options.authorization?.();
        if (!captured) throw Error("Fixture credential removed");
        prepared.push(captured);
        return {
          executable: process.execPath,
          cwd: process.cwd(),
          env: process.env,
          args: [fixture, scenario],
          models,
          cleanup: async () => {
            closed.push(captured);
          },
        };
      },
    );
    try {
      await t.engine.start("owned", "first", "text");
      await until(() => t.engine.snapshot().status === "completed");
      const first = t.engine.snapshot();
      await t.engine.start("owned", "unchanged", "text");
      await until(() => t.engine.snapshot().status === "completed");
      assert.deepEqual(prepared, ["first-fixture-key"]);
      credential = "replacement-fixture-key";
      t.engine.invalidateIntegrations();
      await t.engine.start("owned", "after replacement", "text");
      await until(() => t.engine.snapshot().status === "completed");
      assert.deepEqual(closed, ["first-fixture-key"]);
      assert.deepEqual(prepared, [
        "first-fixture-key",
        "replacement-fixture-key",
      ]);
      assert.equal(t.engine.snapshot().sessionId, first.sessionId);
      assert.equal(t.engine.snapshot().threadId, first.threadId);
      credential = undefined;
      t.engine.invalidateIntegrations();
      await assert.rejects(
        t.engine.start("owned", "must not infer", "text"),
        /Fixture credential removed/,
      );
      assert.deepEqual(closed, prepared);
      assert.equal(t.engine.snapshot().status, "failed");
    } finally {
      await t.engine.dispose();
    }
  }
});
test("OpenAI adapter fixture transmits original model/effort, keeps Core context and revalidates reused sessions", async () => {
  for (const scenario of ["openai", "openai-catalog-removed"]) {
    const t = setup(scenario, {
      provider: "openai",
      model: "wire-fixture",
      context: () => ({
        cwd: "/synora-fixture",
        profile: "high",
        context: null,
        binding: t.binding(),
      }),
    });
    try {
      await t.engine.start("owned", "fixture", "text");
      await until(() => t.engine.snapshot().status === "completed");
      const s = t.engine.snapshot();
      assert.deepEqual(s.selection, {
        model: "wire-fixture",
        profile: "high",
        context: null,
        contextRequestField: "core-managed",
      });
      assert.equal(s.modelCatalog?.[0].coreModel?.id, "picker-fixture");
      if (scenario === "openai") {
        await t.engine.start("owned", "second fixture", "text");
        await until(() => t.engine.snapshot().status === "completed");
        assert.equal(t.engine.snapshot().sessionId, s.sessionId);
      } else {
        await assert.rejects(
          t.engine.start("owned", "must not infer", "text"),
          /no picker-visible/,
        );
        assert.equal(t.engine.snapshot().status, "failed");
      }
    } finally {
      await t.engine.dispose();
    }
  }
});
test("Core permission downgrade is actionable before model inference, never silently treated as workspace-write", async () => {
  const { engine, events, binding } = setup("permission-downgrade");
  try {
    await assert.rejects(
      engine.start("local", "fixture", "text"),
      /Core selected readOnly/,
    );
    assert.equal(binding(), undefined);
    assert.ok(
      !events.some(
        (e) =>
          e.event.kind === "protocol" &&
          e.event.payload.method === "turn/started",
      ),
    );
  } finally {
    await engine.dispose();
  }
});
for (const provider of [undefined, "openai"] as const)
  test(`${provider ?? "Axiom"} cancellation keeps a cleanup lock until owned process/resources release, then resumes the same identity`, async () => {
    let releaseCleanup!: () => void;
    const cleanupAllowed = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const t = setup(
      "openai-wait",
      {
        provider,
        model: provider ? "wire-fixture" : "qwen3.8-27b-nvfp4",
        context: () => ({
          cwd: "/synora-fixture",
          profile: provider ? "high" : "ultra-fast",
          context: provider ? null : 262144,
          binding: t.binding(),
        }),
      },
      async () => ({
        executable: process.execPath,
        cwd: process.cwd(),
        env: process.env,
        args: [fixture, provider ? "openai-wait" : "wait"],
        models,
        // A process can exit between two polling ticks. Hold its owned resource
        // cleanup explicitly instead of assuming a platform-specific exit delay.
        cleanup: () => cleanupAllowed,
      }),
    );
    try {
      await t.engine.start("owned", "fixture", "text");
      const first = t.engine.snapshot();
      const pending = t.engine.cancel();
      assert.equal(t.engine.cancel(), pending);
      assert.equal(t.engine.snapshot().cleanupPending, true);
      await assert.rejects(
        t.engine.start("owned", "too early", "text"),
        /cancellation cleanup/,
      );
      await until(() => t.engine.snapshot().status === "interrupted");
      assert.equal(t.engine.snapshot().cleanupPending, true);
      releaseCleanup();
      const ended = await pending;
      assert.equal(ended.cleanupPending, false);
      assert.equal(ended.connection, "disconnected");
      await t.engine.start("owned", "resume fixture", "text");
      assert.equal(t.engine.snapshot().sessionId, first.sessionId);
      await t.engine.cancel();
    } finally {
      releaseCleanup();
      await t.engine.dispose();
    }
  });
test("Original plugin MCP inventory is read even without separately configured integrations", async () => {
  const { engine } = setup("plugin-only");
  try {
    await engine.start("owned", "fixture", "text");
    await until(() => engine.snapshot().status === "completed");
    assert.equal(engine.snapshot().mcpServers?.[0].pluginId, "proof@personal");
    assert.equal(engine.snapshot().mcpServers?.[0].name, "proof");
    assert.equal(engine.snapshot().mcpServers?.[0].runtimeStatus, "connected");
  } finally {
    await engine.dispose();
  }
});
test("Live MCP fixture validates actual mounted names, failure and pagination before a turn", async () => {
  for (const scenario of ["text", "mcp-failed", "mcp-missing", "mcp-cursor"]) {
    const { engine, events } = setup(scenario, {
      context: () => ({
        cwd: "/synora-fixture",
        profile: "ultra-fast",
        context: 262144,
        integrations: [
          {
            id: "test-web",
            name: "Test web",
            kind: "connector",
            executor: "searxng",
            endpoint: "http://127.0.0.1:9998",
            enabled: true,
            auth: "none",
            tools: [],
          },
        ],
      }),
    });
    try {
      if (scenario === "text") {
        await engine.start("local", "fixture", "text");
        await until(() => engine.snapshot().status === "completed");
        assert.equal(
          engine.snapshot().mcpServers?.[0].runtimeStatus,
          "connected",
        );
        engine.invalidateIntegrations();
        assert.deepEqual(engine.snapshot().mcpServers, []);
      } else {
        await assert.rejects(
          engine.start("local", "fixture", "text"),
          /did not connect|both web|repeated an MCP/,
        );
        assert.ok(
          !events.some(
            (e) =>
              e.event.kind === "protocol" &&
              e.event.payload.method === "turn/started",
          ),
        );
      }
    } finally {
      await engine.dispose();
    }
  }
});
test("Live adapter fixture retains summary-omitted items and stable local/thread/session IDs", async () => {
  const { engine, events, binding } = setup();
  try {
    await engine.start("local-conversation", "fixture prompt", "text");
    await until(() => engine.snapshot().status === "completed");
    const s = engine.snapshot();
    assert.equal(s.conversationId, "local-conversation");
    assert.equal(s.threadId, "fixture-thread");
    assert.equal(s.sessionId, "fixture-session");
    assert.equal(binding()?.threadId, "fixture-thread");
    assert.deepEqual(
      s.items.map((i) => i.id),
      ["fixture-user", "fixture-tool-item", "fixture-assistant"],
    );
    assert.ok(events.every((e) => !e.simulated));
    const initialMessage = events.find(
      (e) =>
        e.event.kind === "protocol" &&
        e.event.payload.method === "item/started" &&
        e.event.payload.params.item.type === "agentMessage",
    );
    assert.ok(
      initialMessage?.event.kind === "protocol" &&
        initialMessage.event.payload.method === "item/started",
    );
    assert.equal(
      (initialMessage.event.payload.params.item as { text: string }).text,
      "",
      "Later deltas must not mutate the replay journal",
    );
    assert.deepEqual(events.reduce(reduceEngine, emptyEngine).items, s.items);
    assert.ok(s.firstDeltaAt);
    assert.equal(s.error, null);
  } finally {
    await engine.dispose();
  }
});
test("Live fixture approvals preserve numeric/string IDs, queue order and exact decisions", async () => {
  for (const scenario of ["approvals", "approvals-delayed"]) {
    const { engine } = setup(scenario);
    try {
      await engine.start("local", "fixture", "text");
      await until(() => engine.snapshot().status === "waiting");
      const first = engine.snapshot().approval!;
      assert.equal(first.params.itemId, "item-number");
      engine.approve(first.id, false);
      // Separate JSONL writes need not arrive in the same read. Wait for the
      // actual second request rather than interpreting IPC scheduling as a queue failure.
      await until(() => !!engine.snapshot().approval);
      const second = engine.snapshot().approval!;
      assert.equal(second.params.itemId, "item-string");
      assert.throws(() => engine.approve(first.id, true), /stale/);
      engine.approve(second.id, true);
      await until(() => engine.snapshot().status === "completed");
      const a = engine.snapshot().items.find((i) => i.type === "agentMessage")!;
      assert.ok(a.type === "agentMessage");
      assert.deepEqual(JSON.parse(a.text), [
        { type: "number", id: 7, decision: "decline" },
        { type: "string", id: "7", decision: "accept" },
      ]);
    } finally {
      await engine.dispose();
    }
  }
});
test("User questions and turn-scoped permissions retain callback identity, validate answers and clear after completion", async () => {
  for (const accepted of [false, true]) {
    const { engine } = setup("user-input");
    try {
      await engine.start("local", "fixture", "text");
      await until(
        () =>
          !!engine.snapshot().approval &&
          engine.snapshot().questions?.length === 1,
      );
      const q = engine.snapshot().questions![0],
        approval = engine.snapshot().approval!;
      assert.equal(q.params.isBlocking, true);
      assert.equal(q.params.questions[1].isSecret, true);
      assert.throws(
        () => engine.answer(q.id, { choice: ["A"] }),
        /question IDs/,
      );
      assert.throws(
        () =>
          engine.answer(q.id, { choice: ["invented"], private: ["test-only"] }),
        /offered answers/,
      );
      engine.answer(q.id, {
        choice: ["B"],
        private: ["fixture-secret-never-a-real-key"],
      });
      assert.equal(engine.snapshot().questions?.length, 0);
      assert.equal(
        engine.snapshot().status,
        "waiting",
        "Permission request must remain pending",
      );
      engine.approve(approval.id, accepted);
      await until(() => engine.snapshot().status === "completed");
      const a = engine.snapshot().items.find((i) => i.type === "agentMessage")!;
      assert.ok(a.type === "agentMessage");
      const replies = JSON.parse(a.text);
      assert.equal(replies[0].id, 7);
      assert.equal(replies[0].idType, "number");
      assert.deepEqual(replies[0].result.answers.choice.answers, ["B"]);
      assert.equal(replies[1].id, "7");
      assert.equal(replies[1].idType, "string");
      assert.deepEqual(replies[1].result, {
        permissions: accepted ? { network: { enabled: true } } : {},
        scope: "turn",
      });
      assert.throws(
        () => engine.answer(q.id, { choice: ["A"], private: ["stale"] }),
        /stale/,
      );
      assert.deepEqual(engine.snapshot().questions, []);
      assert.equal(engine.snapshot().approval, null);
    } finally {
      await engine.dispose();
    }
  }
});
test("Core-resolved question cannot be answered late or keep the UI blocked", async () => {
  const { engine } = setup("resolved-input");
  try {
    await engine.start("local", "fixture", "text");
    await until(() => engine.snapshot().questions?.length === 1);
    const id = engine.snapshot().questions![0].id;
    await until(() => engine.snapshot().status === "completed");
    assert.deepEqual(engine.snapshot().questions, []);
    assert.throws(
      () => engine.answer(id, { choice: ["A"], private: ["stale"] }),
      /resolved or is stale/,
    );
  } finally {
    await engine.dispose();
  }
});
test("Live fixture cancellation is terminal, idempotent and does not reset sequence", async () => {
  const { engine } = setup("wait");
  try {
    await engine.start("local", "wait", "text");
    const seq = engine.snapshot().sequence;
    assert.equal((await engine.cancel()).status, "interrupted");
    assert.ok(engine.snapshot().sequence > seq);
    assert.equal((await engine.cancel()).status, "interrupted");
  } finally {
    await engine.dispose();
  }
});
test("Axiom cancellation keeps admission locked while Core confirms command termination, with original tool identity", async () => {
  const { engine } = setup("cancel-command");
  try {
    await engine.start("owned", "fixture", "text");
    await until(() =>
      engine.snapshot().items.some((i) => i.type === "commandExecution"),
    );
    const before = engine.snapshot();
    const pending = engine.cancel();
    assert.equal(engine.cancel(), pending);
    assert.equal(engine.snapshot().cleanupPending, true);
    await until(() => engine.snapshot().status === "interrupted");
    await assert.rejects(
      engine.start("owned", "too soon", "text"),
      /cancellation cleanup/,
    );
    const after = await pending;
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.turnId, before.turnId);
    assert.equal(after.sessionId, before.sessionId);
    assert.equal(after.cleanupPending, false);
    assert.equal(after.connection, "disconnected");
    const item = after.items.find((i) => i.type === "commandExecution");
    assert.ok(item?.type === "commandExecution");
    assert.equal(item.status, "failed");
    assert.equal(item.exitCode, 137);
    assert.equal(
      item.id,
      before.items.find((i) => i.type === "commandExecution")!.id,
    );
  } finally {
    await engine.dispose();
  }
});
test("Cancellation during preparation never starts a child afterwards or loses the next turn", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const engine = new LiveEngine(
    {
      executable: process.execPath,
      stateDirectory: "/synora-fixture",
      endpoint,
      model: "qwen3.8-27b-nvfp4",
      context: () => ({
        cwd: "/synora-fixture",
        profile: "ultra-fast",
        context: 262144,
      }),
      bind: () => {},
      sink: () => {},
    },
    async () => {
      await gate;
      return {
        executable: process.execPath,
        cwd: process.cwd(),
        env: process.env,
        args: [fixture],
        models,
      };
    },
  );
  try {
    const start = engine.start("local", "hello", "text");
    assert.equal((await engine.cancel()).status, "interrupted");
    release();
    assert.equal((await start).status, "interrupted");
    await engine.start("local", "again", "text");
    await until(() => engine.snapshot().status === "completed");
  } finally {
    release();
    await engine.dispose();
  }
});
test("Live fixture deadline interrupts upstream and reports a real timeout, not success", async () => {
  const { engine } = setup("wait", { turnDeadlineMs: 25 });
  try {
    await engine.start("local", "wait", "text");
    await until(() => engine.snapshot().status === "failed");
    assert.equal(engine.snapshot().error?.code, "TURN_DEADLINE");
  } finally {
    await engine.dispose();
  }
});
test("Malformed delta fails instead of silently discarding unknown item data", async () => {
  const { engine } = setup("malformed");
  try {
    try {
      await engine.start("local", "fixture", "text");
    } catch {}
    await until(() => engine.snapshot().status === "failed");
    assert.match(engine.snapshot().error!.message, /unknown item/);
  } finally {
    await engine.dispose();
  }
});
test("Restore paginates all history and rejects a mismatched identity or repeated cursor", async () => {
  const binding = {
    threadId: "fixture-thread",
    sessionId: "fixture-session",
    endpoint,
    model: "qwen3.8-27b-nvfp4",
    cwd: "/synora-fixture",
  };
  for (const scenario of ["text", "wrong-identity", "repeated-cursor"]) {
    const { engine, events } = setup(scenario, {
      context: () => ({
        cwd: "/synora-fixture",
        profile: "ultra-fast",
        context: 262144,
        binding,
      }),
    });
    try {
      if (scenario === "text") {
        assert.equal((await engine.restore("local")).status, "completed");
        assert.equal(
          events.filter((e) => e.event.kind === "history").length,
          2,
        );
        assert.equal(engine.snapshot().items.length, 3);
      } else
        await assert.rejects(
          engine.restore("local"),
          scenario === "wrong-identity"
            ? /different thread\/session/
            : /repeated a history cursor/,
        );
    } finally {
      await engine.dispose();
    }
  }
});
test("Axiom configuration does not inherit account keys; strict protocol and endpoint validation stay enabled", () => {
  const env = appServerEnvironment("/synora-state", {
    PATH: "/bin",
    HOME: "/user",
    OPENAI_API_KEY: "not-a-real-secret",
    CODEX_HOME: "/other-codex",
    HF_TOKEN: "not-a-real-secret",
  });
  assert.equal(env.CODEX_HOME, resolve("/synora-state"));
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.HF_TOKEN, undefined);
  for (const url of [
    "http://127.0.0.1/v1",
    "file:///tmp/codex/v1",
    "http://a:b@localhost/codex/v1",
  ])
    assert.throws(() => axiomEndpoint(url));
  assert.throws(() => parseResponse("turn", { turn: { status: "completed" } }));
  assert.throws(() =>
    parseNotification({ method: "turn/completed", params: {} }),
  );
});
