/** Production LocalService + LiveEngine, controlled catalogs and JSONL Core
 * process only. No public accounts, network, model inference or Mac changes. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LocalService, type Host } from "../src/main/service";
import { LiveEngine } from "../src/engine/live-engine";
import type { EngineConfig, Integration, ModelCapabilities, Result } from "../src/shared/contracts";

const fixture = fileURLToPath(new URL("./fixtures/live-app-server.mjs", import.meta.url));
const unwrap = <T>(r: Result<T>) => { if (!r.ok) throw Error(r.error.message); return r.value; };
async function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "synora-restore-")), log = join(dir, "rpc.jsonl");
  mkdirSync(join(dir, "workspace"));
  const host: Host = {
    capabilities: { platform: "web", transport: "local-http", nativeDialogs: false, terminal: false,
      embeddedBrowser: false, engine: "simulated", liveInference: false },
    closeReady() {}, chooseWorkspace: async () => null, importPreset: async () => null, exportPreset: async () => false,
    browser: { open: () => [], navigate() {}, action: () => [], layout() {}, list: () => [], dispose() {} },
  };
  let service = new LocalService(join(dir, "state.sqlite"), host, () => {}, 1, { disabledReason: "Controlled restore test" });
  const catalogs = (provider: Integration): ModelCapabilities[] => provider.providerType === "openai"
    ? [{ id: "wire-fixture", context_window: null, context_window_options: [], reasoning_efforts: ["low", "high"], default_reasoning_effort: "low" }]
    : [{ id: "qwen3.8-27b-nvfp4", context_window: 262144, context_window_options: [262144], reasoning_efforts: ["ultra-fast"] }];
  const patchEngine = (engine: LocalService["engine"], config: EngineConfig) => {
    if (engine instanceof LiveEngine) {
      (engine as any).prepare = async () => ({ executable: process.execPath, cwd: dir,
        args: [fixture, "provider-restore", config.providerId],
        env: { ...process.env, SYNORA_FIXTURE_RPC_LOG: log },
        models: catalogs(service.store.read().integrations.find(p => p.id === config.providerId)!) });
    }
    return engine;
  };
  const patchService = () => {
    const internals = service as any, make = internals.makeEngine.bind(service);
    t.mock.method(internals, "inventory", async (p: Integration) => catalogs(p));
    t.mock.method(internals, "makeEngine", (config: EngineConfig, sequence: number) => patchEngine(make(config, sequence), config));
    patchEngine(service.engine, service.store.read().engine);
  };
  patchService();
  const ws = service.store.addWorkspace(join(dir, "workspace"), "Owned QA");
  const providers: Integration[] = [
    { id: "axiom", kind: "provider", providerType: "axiom", name: "Fixture Axiom", endpoint: "http://127.0.0.1:9999/codex/v1", auth: "none", enabled: true, tools: [] },
    { id: "openai", kind: "provider", providerType: "openai", name: "Fixture OpenAI", endpoint: "https://api.openai.com/v1", auth: "core-account", enabled: true, tools: [] },
  ];
  const chats = providers.map(p => service.store.conversation(ws.id));
  service.store.update(s => {
    s.integrations = providers;
    for (const [i, p] of providers.entries()) {
      const c = s.conversations.find(c => c.id === chats[i].id)!;
      c.title = p.id; c.draft = `PRESERVE_${p.id}`;
      c.messages = [{ id: `${p.id}-cached`, role: "assistant", text: "Saved history", simulated: false }];
      c.binding = { threadId: `${p.id}-thread`, sessionId: `${p.id}-session`, endpoint: p.endpoint,
        model: catalogs(p)[0].id, cwd: ws.path };
    }
  });
  unwrap(await service.api.engineConfigure({ mode: "live", providerId: "axiom", model: "qwen3.8-27b-nvfp4" }));
  const calls = (): Array<{ method: string; pid: number; params: any }> => {
    try { return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map(v => JSON.parse(v)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  };
  t.after(async () => { await service.dispose(); t.mock.restoreAll(); rmSync(dir, { recursive: true }); });
  return { get service() { return service; }, get internals() { return service as any; }, calls, chats, providers,
    reopen: async () => {
      await service.dispose();
      service = new LocalService(join(dir, "state.sqlite"), host, () => {}, 1, { disabledReason: "Controlled cold restore test" });
      patchService();
    } };
}

test("Saved OpenAI/Axiom chats restore through their original provider in both directions without new chat or inference", async t => {
  const f = await setup(t), before = f.service.store.read();
  for (const i of [1, 0, 1]) {
    const restored = unwrap(await f.service.api.engineRestore(f.chats[i].id));
    assert.equal(restored.connection, "live");
    assert.equal(restored.status, "completed");
    assert.equal(restored.threadId, `${f.providers[i].id}-thread`);
    assert.equal(restored.sessionId, `${f.providers[i].id}-session`);
    assert.equal(f.service.store.read().engine.providerId, f.providers[i].id);
    const original = before.conversations.find(c => c.id === f.chats[i].id)!;
    const after = f.service.store.read().conversations.find(c => c.id === original.id)!;
    assert.deepEqual(after.binding, original.binding, "Legacy binding must not be rewritten by routing");
    assert.equal(after.draft, original.draft);
    assert.equal(f.service.store.read().conversations.length, before.conversations.length);
  }
  const resumes = f.calls().filter(c => c.method === "thread/resume");
  assert.deepEqual(resumes.map(c => c.params.modelProvider), ["openai", "synora_axiom", "openai"]);
  assert.equal(resumes[0].params.config.model_reasoning_effort, "low", "Use target model default, never Axiom effort");
  assert.equal(resumes[0].params.config.model_context_window, undefined);
  assert.equal(resumes[1].params.config.model_context_window, 262144);
  assert.equal(f.calls().some(c => ["thread/start", "turn/start"].includes(c.method)), false);
});

test("Cold SQLite reopen restores the original OpenAI Core session, cached records and draft with global Axiom selected", async t => {
  const f = await setup(t), before = f.service.store.read();
  await f.reopen();
  assert.deepEqual(f.service.store.read().conversations, before.conversations);
  assert.equal(f.service.store.read().engine.providerId, "axiom");
  const result = unwrap(await f.service.api.engineRestore(f.chats[1].id));
  assert.equal(result.threadId, "openai-thread");
  assert.equal(result.sessionId, "openai-session");
  assert.equal(result.status, "completed");
  assert.equal(result.connection, "live");
  const chat = f.service.store.read().conversations.find(c => c.id === f.chats[1].id)!;
  assert.deepEqual(chat.binding, before.conversations.find(c => c.id === chat.id)!.binding);
  assert.equal(chat.draft, "PRESERVE_openai");
  assert.equal(f.calls().some(c => ["thread/start", "turn/start"].includes(c.method)), false);
});

test("Current model effort is retained on same-provider restores; absent target models never replace the active engine", async t => {
  const f = await setup(t);
  unwrap(await f.service.api.engineConfigure({ mode: "live", providerId: "openai", model: "wire-fixture", reasoningEffort: "high" }));
  unwrap(await f.service.api.engineRestore(f.chats[1].id));
  assert.equal(f.calls().find(c => c.method === "thread/resume")!.params.config.model_reasoning_effort, "high");
  const before = f.service.store.read(), engine = f.service.engine;
  t.mock.method(f.internals, "inventory", async () => []);
  const failed = await f.service.api.engineRestore(f.chats[0].id);
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.match(failed.error.message, /not advertised/);
  assert.equal(f.service.engine, engine);
  assert.deepEqual(f.service.store.read(), before);
});

test("Cross-provider restore holds the configuration gate through catalog and Core restoration", async t => {
  const f = await setup(t);
  const inventory = f.internals.inventory.bind(f.service);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(f.internals, "inventory", async (p: Integration) => { await gate; return inventory(p); });
  const pending = f.service.api.engineRestore(f.chats[1].id);
  try {
    assert.equal(f.internals.configuring, true);
    const before = f.service.store.read();
    for (const result of await Promise.all([
      f.service.api.engineRestore(f.chats[0].id),
      f.service.api.engineConfigure({ mode: "simulated", providerId: null, model: null }),
      f.service.api.engineStart(f.chats[0].id, "MUST_NOT_SEND", "text"),
    ])) assert.equal(result.ok, false);
    assert.deepEqual(f.service.store.read(), before);
  } finally { release(); }
  assert.equal(unwrap(await pending).threadId, "openai-thread");
  assert.equal(f.internals.configuring, false);
  assert.equal(f.calls().some(c => ["thread/start", "turn/start"].includes(c.method)), false);
});

test("Missing/disabled/ambiguous provider or changed workspace fails before changing the foreground engine", async t => {
  const f = await setup(t);
  unwrap(await f.service.api.engineRestore(f.chats[0].id));
  const initial = f.service.store.read();
  for (const variant of ["missing", "disabled", "ambiguous", "workspace"] as const) {
    f.service.store.update(s => {
      s.integrations = structuredClone(initial.integrations);
      s.workspaces = structuredClone(initial.workspaces);
      if (variant === "missing") s.integrations = s.integrations.filter(p => p.id !== "openai");
      if (variant === "disabled") s.integrations.find(p => p.id === "openai")!.enabled = false;
      if (variant === "ambiguous") s.integrations.push({ ...f.providers[1], id: "openai-copy" });
      if (variant === "workspace") s.workspaces[0].path += "-changed";
    });
    const before = f.service.store.read(), engine = f.service.engine, snapshot = engine.snapshot(), count = f.calls().length;
    const result = await f.service.api.engineRestore(f.chats[1].id);
    assert.equal(result.ok, false, variant);
    assert.equal(f.service.engine, engine);
    assert.deepEqual(engine.snapshot(), snapshot, variant);
    assert.deepEqual(f.service.store.read(), before, variant);
    assert.equal(f.calls().length, count, "No RPC for incompatible identity");
  }
});
