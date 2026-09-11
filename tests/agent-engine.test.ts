import test from "node:test";
import assert from "node:assert/strict";
import { resolve, join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { LiveEngine } from "../src/engine/live-engine";
import type {
  AxiomRequestMetrics,
  EngineBinding,
} from "../src/shared/contracts";
import { Store } from "../src/main/store";

const metric: AxiomRequestMetrics = {
  source: "axiom-response",
  responseId: "child-response",
  model: "qwen3.8-27b-nvfp4",
  threadId: "fixture-child",
  sessionId: "fixture-session",
  turnId: "fixture-child-turn",
  observedAt: 1000,
  profile: "ultra-fast",
  thinkingBudget: 0,
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  thinkingTokens: 0,
  visibleTokens: 20,
  prefillSeconds: 1,
  decodeSeconds: 0.5,
  ttftSeconds: 1.01,
  decodeTokensPerSecond: 40,
  visibleTokensPerSecond: 40,
  decodePath: "fixture",
  speculativeMode: "fixture",
  prefixHitTokens: 0,
  suffixPrefillTokens: 100,
};
for (const scenario of ["subagents", "subagents-wrong-parent", "subagents-read-error"])
  test(`${scenario}: original activity discovers a child without collab receiver IDs; history restores without executing it`, async () => {
    let binding: EngineBinding | undefined;
    const make = () => new LiveEngine({ stateDirectory: "/synora-fixture",
      endpoint: "http://127.0.0.1:9999/codex/v1", model: metric.model,
      context: () => ({ cwd: "/synora-fixture", profile: "ultra-fast", context: 262144, binding }),
      bind: (_id, value) => { binding = value; }, sink: () => {},
    }, async () => ({ executable: process.execPath,
      args: [resolve("tests/fixtures/live-app-server.mjs"), scenario],
      cwd: process.cwd(), env: process.env, models: [] }));
    let engine = make();
    try {
      await engine.start("owned", "fixture", "text");
      await until(() => engine.snapshot().status === "completed");
      if (scenario !== "subagents") {
        await until(() => !!engine.snapshot().agents[0]?.metadataError);
        const child = engine.snapshot().agents[0];
        assert.equal(child.parentId, "fixture-thread");
        assert.equal(child.name, "/root/fixture-reader");
        assert.equal(child.result, "", "Parent completion cannot fabricate a child result");
        assert.equal(child.activity, undefined);
        assert.notEqual(child.status, "completed");
        return;
      }
      await until(() => engine.snapshot().agents[0]?.status === "completed");
      const original = engine.snapshot().agents[0];
      assert.equal(original.id, "fixture-child");
      assert.equal(original.parentId, "fixture-thread");
      assert.equal(original.name, "Darwin");
      assert.equal(original.coreSessionId, "core-child-session");
      assert.equal(original.result, "CHILD_RESULT");
      assert.equal(original.activity?.find(i => i.type === "commandExecution")?.exitCode, 0);
      await engine.dispose();
      engine = make();
      const restored = await engine.restore("owned");
      assert.equal(restored.agents.length, 1);
      assert.deepEqual(restored.agents[0], original);
      assert.equal(restored.items.some(i => i.type === "subAgentActivity"), false,
        "Child discovery also reads older paginated items, not only last-turn summary");
    } finally { await engine.dispose(); }
  });
async function until(fn: () => boolean) {
  const end = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > end) throw new Error("Agent fixture timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
}
test("Child metadata, streaming, pre-close completed status and exact per-child metrics survive delayed reads and restart", async () => {
  let observe: ((m: AxiomRequestMetrics) => void) | undefined,
    binding: EngineBinding | undefined;
  const engine = new LiveEngine(
    {
      stateDirectory: "/synora-fixture",
      endpoint: "http://127.0.0.1:9999/codex/v1",
      model: metric.model,
      context: () => ({
        cwd: "/synora-fixture",
        profile: "ultra-fast",
        context: 262144,
        binding,
      }),
      bind: (_id, b) => {
        binding = b;
      },
      sink: () => {},
    },
    async (o) => {
      observe = o.onMetrics;
      return {
        executable: process.execPath,
        args: [resolve("tests/fixtures/live-app-server.mjs"), "agents"],
        cwd: process.cwd(),
        env: process.env,
        models: [],
      };
    },
  );
  const dir = await mkdtemp(join(tmpdir(), "synora-agent-store-"));
  let store = new Store(join(dir, "state.sqlite"));
  try {
    await engine.start("local", "fixture", "text");
    observe!(metric); // Arrives before spawn result; correlated only after child identity is known.
    observe!({ ...metric, responseId: "foreign-session", sessionId: "alien" });
    observe!({ ...metric, responseId: "foreign-thread", threadId: "alien" });
    await until(() => engine.snapshot().status === "completed");
    await until(
      () =>
        engine.snapshot().agents[0]?.name === "Darwin" &&
        engine.snapshot().agents[0]?.status === "completed",
    );
    // Wait for the queued final read, not just the stale first response.
    await until(() => engine.snapshot().agents[0]?.completedAt === 2000);
    observe!(metric);
    const child = engine.snapshot().agents[0];
    assert.equal(child.closed, true);
    assert.equal(child.parentId, "fixture-thread");
    assert.equal(child.coreSessionId, "core-child-session");
    assert.equal(child.turnId, "fixture-child-turn");
    assert.equal(child.result, "CHILD_RESULT");
    assert.deepEqual(child.backendRequests, [metric]);
    assert.equal(
      child.activity?.filter((i) => i.id === "child-command").length,
      1,
    );
    assert.equal(
      child.activity?.find((i) => i.type === "commandExecution")?.exitCode,
      0,
    );
    assert.equal(
      engine.snapshot().backendRequests?.length,
      0,
      "Child requests cannot inflate parent telemetry",
    );
    store.update((s) => {
      s.agentHistory = [child];
    });
    store.close();
    store = new Store(join(dir, "state.sqlite"));
    assert.deepEqual(store.read().agentHistory, [child]);
    assert.throws(() =>
      store.update((s) => {
        s.agentHistory[0].backendRequests![0].thinkingTokens = -1;
      }),
    );
    assert.deepEqual(store.read().agentHistory, [child]);
  } finally {
    await engine.dispose();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
for (const scenario of ["agents-wrong-parent", "agents-read-error"])
  test(`${scenario}: metadata failure is explicit; original completed work and closure retained`, async () => {
    const engine = new LiveEngine(
      {
        stateDirectory: "/synora-fixture",
        endpoint: "http://127.0.0.1:9999/codex/v1",
        model: metric.model,
        context: () => ({
          cwd: "/synora-fixture",
          profile: "ultra-fast",
          context: 262144,
        }),
        bind: () => {},
        sink: () => {},
      },
      async () => ({
        executable: process.execPath,
        args: [resolve("tests/fixtures/live-app-server.mjs"), scenario],
        cwd: process.cwd(),
        env: process.env,
        models: [],
      }),
    );
    try {
      await engine.start("local", "fixture", "text");
      await until(
        () =>
          engine.snapshot().status === "completed" &&
          !!engine.snapshot().agents[0]?.metadataError,
      );
      const child = engine.snapshot().agents[0];
      assert.equal(child.closed, true);
      assert.equal(child.status, "completed");
      assert.equal(child.parentId, "fixture-thread");
      assert.equal(child.name, child.id);
      assert.equal(child.result, "CHILD_RESULT");
      assert.match(
        child.metadataError!,
        scenario.includes("wrong") ? /lineage/ : /metadata unavailable/,
      );
    } finally {
      await engine.dispose();
    }
  });
