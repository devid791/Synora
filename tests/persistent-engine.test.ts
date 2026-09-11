import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LiveEngine, type LiveContext } from "../src/engine/live-engine";
import type { prepareAxiomProcess } from "../src/engine/axiom-process";
import type { EngineBinding, EngineSnapshot } from "../src/shared/contracts";
import { appServerMessage } from "../src/renderer/AppServerConnection";

const fixture = fileURLToPath(
  new URL("./fixtures/live-app-server.mjs", import.meta.url),
);
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(fn: () => boolean) {
  const deadline = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > deadline)
      throw Error("Persistent connection fixture deadline");
    await pause(5);
  }
}
function setup(
  opts: {
    scenario?: string;
    allowed?: () => boolean;
    beforePrepare?: () => Promise<void>;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), "synora-persistent-"));
  const log = join(dir, "rpc.jsonl");
  let binding: EngineBinding | undefined;
  let prepares = 0;
  const snapshots: EngineSnapshot[] = [];
  const context = (): LiveContext => ({
    cwd: "/synora-fixture",
    profile: "ultra-fast",
    context: 262144,
    binding,
  });
  const prepare: typeof prepareAxiomProcess = async () => {
    prepares++;
    await opts.beforePrepare?.();
    return {
      executable: process.execPath,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_FIXTURE_RPC_LOG: log },
      args: [fixture, opts.scenario ?? "text"],
      models: [
        {
          id: "qwen3.8-27b-nvfp4",
          context_window: 262144,
          context_window_options: [262144],
          reasoning_efforts: ["ultra-fast"],
        },
      ],
    };
  };
  const engine = new LiveEngine(
    {
      executable: process.execPath,
      stateDirectory: dir,
      endpoint: "http://127.0.0.1:9999/codex/v1",
      model: "qwen3.8-27b-nvfp4",
      context,
      bind: (_id, b) => {
        binding = b;
      },
      sink: () => snapshots.push(engine.snapshot()),
      persistent: {
        context: async () => context(),
        allowed: opts.allowed ?? (() => true),
        heartbeatMs: 25,
        retryMs: 15,
      },
    },
    prepare,
  );
  const calls = (): {
    pid: number;
    method: string;
    params?: Record<string, unknown>;
  }[] => {
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
  return {
    engine,
    calls,
    snapshots,
    prepares: () => prepares,
    binding: () => binding,
    setBinding: (value: EngineBinding | undefined) => { binding = value; },
    close: async () => {
      await engine.dispose();
      rmSync(dir, { recursive: true });
    },
  };
}

test("Parent warms before first message and remains ready; idle heartbeat creates no thread or inference", async () => {
  const t = setup();
  try {
    await until(
      () =>
        t.calls().filter((c) => c.method === "thread/loaded/list").length >= 2,
    );
    const s = t.engine.snapshot();
    assert.equal(s.connection, "live");
    assert.equal(s.appServer?.phase, "ready");
    assert.ok(s.appServer?.pid);
    assert.equal(s.threadId, null);
    assert.equal(s.turnId, null);
    assert.equal(t.binding(), undefined);
    assert.equal(t.prepares(), 1);
    assert.deepEqual([...new Set(t.calls().map((c) => c.method))].sort(), [
      "initialize",
      "initialized",
      "thread/loaded/list",
      ...(process.platform === "win32" ? ["windowsSandbox/readiness"] : []),
    ]);
    assert.ok(t.calls().every((c) => c.pid === s.appServer?.pid));
  } finally {
    await t.close();
  }
});

test("Incompatible binding is rejected before adopting its conversation and never poisons resident recovery", async () => {
  const t = setup();
  try {
    await t.engine.start("owned", "one", "text");
    await until(() => t.engine.snapshot().status === "completed");
    const before = t.engine.snapshot(), original = t.binding()!;
    t.setBinding({ ...original, endpoint: "https://api.openai.com/v1", model: "other-provider-model" });
    for (const action of [() => t.engine.restore("incompatible"), () => t.engine.start("incompatible", "MUST_NOT_SEND", "text"), () => t.engine.compact("incompatible")]) {
      await assert.rejects(action(), /different provider, model or workspace/);
      assert.deepEqual(t.engine.snapshot(), before);
    }
    await pause(100); // Multiple fixture heartbeats: no bad resume or reprepare.
    assert.equal(t.engine.snapshot().conversationId, "owned");
    assert.equal(t.engine.snapshot().appServer?.pid, before.appServer?.pid);
    assert.equal(t.prepares(), 1);
    assert.equal(t.calls().filter(c => c.method === "turn/start").length, 1);
    assert.equal(t.calls().filter(c => c.method === "thread/resume").length, 0);
    t.setBinding(original);
    const restoring = t.engine.restore("owned");
    assert.equal(t.engine.snapshot().threadId, null);
    assert.equal(t.engine.snapshot().sessionId, undefined, "Never display a stale session before Core acknowledges restore");
    assert.equal((await restoring).sessionId, original.sessionId);
  } finally { await t.close(); }
});

test("Two completed fixture turns keep the same Core PID and original thread/session", async () => {
  const t = setup();
  try {
    await until(() => t.engine.snapshot().connection === "live");
    const pid = t.engine.snapshot().appServer!.pid;
    await t.engine.start("owned", "one", "text");
    await until(() => t.engine.snapshot().status === "completed");
    const binding = t.binding();
    await pause(55);
    await t.engine.start("owned", "two", "text");
    await until(() => t.engine.snapshot().status === "completed");
    assert.deepEqual(t.binding(), binding);
    assert.equal(t.engine.snapshot().appServer?.pid, pid);
    assert.equal(t.calls().filter((c) => c.method === "initialize").length, 1);
    assert.equal(t.calls().filter((c) => c.method === "turn/start").length, 2);
  } finally {
    await t.close();
  }
});

test("Idle process exit reconnects automatically without starting a thread or replaying work", async () => {
  const t = setup();
  try {
    await until(() => t.engine.snapshot().connection === "live");
    const pid = t.engine.snapshot().appServer!.pid!;
    process.kill(pid, "SIGKILL"); // Only this test's owned protocol fixture.
    await until(
      () =>
        t.engine.snapshot().appServer?.phase === "ready" &&
        t.engine.snapshot().appServer?.pid !== pid,
    );
    assert.equal(t.prepares(), 2);
    assert.equal(
      t
        .calls()
        .some((c) => c.method === "turn/start" || c.method === "thread/start"),
      false,
    );
    assert.ok(t.snapshots.some((s) => s.connection === "disconnected"));
  } finally {
    await t.close();
  }
});

test("Automatic recovery retains original identities and never replays completed or interrupted turns", async () => {
  for (const scenario of ["text", "persistent-wait"]) {
    const t = setup({ scenario });
    try {
      await t.engine.start("owned", "do not replay", "text");
      await until(
        () =>
          t.engine.snapshot().status ===
          (scenario === "text" ? "completed" : "running"),
      );
      const before = t.engine.snapshot(),
        binding = t.binding();
      process.kill(before.appServer!.pid!, "SIGKILL");
      await until(() =>
        t
          .calls()
          .some(
            (c) =>
              c.pid !== before.appServer!.pid &&
              c.method === "thread/turns/list",
          ),
      );
      await until(
        () => !["running", "waiting"].includes(t.engine.snapshot().status),
      );
      const after = t.engine.snapshot();
      assert.equal(after.connection, "live");
      assert.equal(after.threadId, before.threadId);
      assert.equal(after.sessionId, before.sessionId);
      assert.equal(after.turnId, before.turnId);
      assert.deepEqual(t.binding(), binding);
      assert.equal(
        t.calls().filter((c) => c.method === "turn/start").length,
        1,
      );
      assert.ok(
        t
          .calls()
          .some(
            (c) =>
              c.pid !== before.appServer!.pid &&
              c.method === "thread/resume" &&
              c.params?.threadId === before.threadId,
          ),
      );
      if (scenario === "persistent-wait")
        assert.equal(after.error?.code, "RECOVERY_INCOMPLETE");
    } finally {
      await t.close();
    }
  }
});

test("First send joins asynchronous startup: one prepare, initialize and turn", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = setup({ beforePrepare: () => gate });
  try {
    await until(() => t.prepares() === 1);
    const turn = t.engine.start("owned", "first", "text");
    release();
    await turn;
    await until(() => t.engine.snapshot().status === "completed");
    assert.equal(t.prepares(), 1);
    assert.equal(t.calls().filter((c) => c.method === "initialize").length, 1);
    assert.equal(t.calls().filter((c) => c.method === "turn/start").length, 1);
  } finally {
    release();
    await t.close();
  }
});

test("Preparation failure backs off honestly, retries, and explicit pause prevents eager spawn", async () => {
  let allowed = false,
    attempts = 0;
  const t = setup({
    allowed: () => allowed,
    beforePrepare: async () => {
      if (++attempts < 3) throw Error("Owned temporary provider outage");
    },
  });
  try {
    await pause(60);
    assert.equal(t.prepares(), 0);
    allowed = true;
    await until(() => t.engine.snapshot().connection === "live");
    assert.equal(t.prepares(), 3);
    const failures = t.snapshots.filter(
      (s) => s.appServer?.phase === "offline",
    );
    assert.ok(failures.some((s) => s.appServer?.attempts === 1));
    assert.ok(failures.some((s) => s.appServer?.attempts === 2));
    assert.ok(
      failures.every(
        (s) => s.connection === "disconnected" && s.appServer?.retryAt,
      ),
    );
    assert.equal(t.calls().filter((c) => c.method === "initialize").length, 1);
  } finally {
    await t.close();
  }
});

test("Dispose during preparation never starts a late child and never schedules reconnect", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const t = setup({ beforePrepare: () => gate });
  try {
    await until(() => t.prepares() === 1);
    const stop = t.engine.dispose();
    release();
    await stop;
    await pause(75);
    assert.equal(t.prepares(), 1);
    assert.deepEqual(t.calls(), []);
  } finally {
    release();
    await t.close();
  }
});

test("Connection UI distinguishes starting, ready, recovery and genuine unavailability", () => {
  const engine = {
    connection: "disconnected",
    appServer: { phase: "starting", attempts: 0 },
  } as EngineSnapshot;
  assert.match(appServerMessage(engine), /Starting App Server/);
  engine.appServer!.phase = "reconnecting";
  assert.match(
    appServerMessage(engine),
    /Previous requests will not be sent again/,
  );
  engine.appServer = { phase: "ready", attempts: 0, pid: 1234 };
  engine.connection = "live";
  assert.match(appServerMessage(engine), /connected · PID 1234/);
  engine.connection = "disconnected";
  engine.appServer = {
    phase: "offline",
    attempts: 2,
    message: "Provider unreachable",
  };
  assert.match(appServerMessage(engine), /unavailable.*Provider unreachable/);
});
