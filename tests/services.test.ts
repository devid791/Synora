import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { LocalService, type Host } from "../src/main/service";
import { operationSchemas, validateOperation } from "../src/shared/operations";
import { reduceEngine, emptyEngine } from "../src/renderer/engine-state";
import type { Result, DesktopEvent } from "../src/shared/contracts";
import type { EventEnvelope } from "../src/shared/contracts";
import { conversationTimeline } from "../src/renderer/conversation-timeline";
import { terminalMarker, terminalSleep } from "./terminal-fixture";
import type { ComputerUse } from "../src/main/computer-use";

const value = <T>(r: Result<T>) => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
async function until(predicate: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for local service");
    await new Promise((r) => setTimeout(r, 10));
  }
}
async function setup() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synora-service-"));
  const project = path.join(dir, "workspace");
  await fs.mkdir(project);
  await fs.writeFile(path.join(project, "note.txt"), "original");
  let exported: unknown = null;
  const events: DesktopEvent[] = [];
  const host: Host = {
    closeReady: () => {},
    capabilities: {
      platform: process.platform as "linux" | "darwin" | "win32",
      transport: "desktop-ipc",
      nativeDialogs: true,
      terminal: true,
      embeddedBrowser: false,
      engine: "simulated",
      liveInference: false,
    },
    chooseWorkspace: async () => project,
    importPreset: async () => exported,
    exportPreset: async (v) => {
      exported = v;
      return true;
    },
    browser: {
      open: () => {
        throw new Error("Test host has no browser");
      },
      list: () => [],
      navigate: () => {},
      action: () => [],
      layout: () => {},
      dispose: () => {},
    },
  };
  const service = new LocalService(
    path.join(dir, "state.sqlite"),
    host,
    (e) => events.push(e),
    0.02,
  );
  return {
    dir,
    project,
    events,
    host,
    service,
    cleanup: async () => {
      await service.dispose();
      await fs.rm(dir, { recursive: true });
    },
  };
}
test("Clipboard uses only the typed host write, preserves state, rejects invalid payloads and reports host failures", async () => {
  const f = await setup();
  try {
    const before = f.service.store.read(), writes: string[] = [];
    assert.equal((await f.service.api.clipboardWriteText("no host")).ok, false);
    f.host.clipboardWriteText = text => { writes.push(text); };
    assert.equal((await f.service.invoke("clipboardWriteText", ["Città 🛰️\noriginal text"])).ok, true);
    assert.deepEqual(writes, ["Città 🛰️\noriginal text"]);
    for (const args of [[1], ["a", "b"], ["a".repeat(4 * 1024 * 1024 + 1)]])
      assert.equal((await f.service.invoke("clipboardWriteText", args)).ok, false);
    assert.equal(writes.length, 1);
    f.host.clipboardWriteText = () => { throw Error("OS write failure"); };
    assert.equal((await f.service.api.clipboardWriteText("error")).ok, false);
    assert.deepEqual(f.service.store.read(), before);
  } finally { await f.cleanup(); }
});
test("Conversation permission operation preserves drafts/history/attachments and rejects busy or unknown targets", async () => {
  const f = await setup();
  try {
    const c = f.service.store.conversation(null), other = f.service.store.conversation(null);
    f.service.store.draft(c.id, "UNCHANGED_DRAFT");
    f.service.store.update(s => { const chat = s.conversations.find(v => v.id === c.id)!;
      chat.messages = [{ id: "real-user-message", role: "user", text: "Saved", simulated: false }];
      chat.binding = { threadId: "same-thread", sessionId: "same-session", cwd: f.project, endpoint: "https://fixture.invalid/v1", model: "fixture" };
    });
    const before = f.service.store.read();
    for (const mode of ["full", "auto-review", "ask"] as const) {
      const after = value(await f.service.api.conversationPermission(c.id, mode));
      assert.equal(after.conversations.length, before.conversations.length);
      const chat = after.conversations.find(v => v.id === c.id)!;
      const original = before.conversations.find(v => v.id === c.id)!;
      assert.deepEqual({ ...chat, defaults: original.defaults }, original);
      assert.equal(chat.defaults!.permission, mode);
      assert.deepEqual(after.conversations.find(v => v.id === other.id), before.conversations.find(v => v.id === other.id));
    }
    const originalSnapshot = f.service.engine.snapshot.bind(f.service.engine);
    f.service.engine.snapshot = () => ({ ...originalSnapshot(), status: "running" });
    assert.equal((await f.service.api.conversationPermission(c.id, "full")).ok, false);
    f.service.engine.snapshot = originalSnapshot;
    assert.equal((await f.service.api.conversationPermission("missing", "full")).ok, false);
    assert.equal(f.service.store.read().preferences.permission, "ask");
    value(await f.service.api.conversationPermission(null, "full"));
    assert.equal(f.service.store.read().conversations.length, before.conversations.length);
    for (const args of [[c.id, "invalid"], ["", "ask"], [c.id, "full", true]]) assert.throws(() => validateOperation("conversationPermission", args));
  } finally { await f.cleanup(); }
});
test("The conversation permission API invalidates control consent only for an actual scoped policy change",async(ctx)=>{
 const f=await setup();
 try{
  const chat=f.service.store.conversation(null),other=f.service.store.conversation(null);
  f.service.store.conversationPermission(chat.id,'full');
  const control=(f.service as unknown as {control:ComputerUse}).control;
  const changed:string[]=[];
  ctx.mock.method(control,'permissionChanged',(id:string)=>{changed.push(id);return false;});
  value(await f.service.api.conversationPermission(chat.id,'full'));
  value(await f.service.api.conversationPermission(null,'full'));
  assert.deepEqual(changed,[]);
  for(const permission of ['ask','auto-review','full'] as const)value(await f.service.api.conversationPermission(chat.id,permission));
  assert.deepEqual(changed,[chat.id,chat.id,chat.id]);
  assert.equal((await f.service.api.conversationPermission('missing','ask')).ok,false);
  assert.deepEqual(changed,[chat.id,chat.id,chat.id]);
  assert(f.service.store.read().conversations.some(c=>c.id===other.id));
 }finally{ctx.mock.restoreAll();await f.cleanup();}
});
test("Worker cleanup failure still closes supervisor, terminals, browser and store", async (ctx) => {
  const t = await setup(),
    order: string[] = [];
  const coordinator = (t.service as any).delegations;
  const original = coordinator.dispose.bind(coordinator);
  ctx.mock.method(coordinator, "dispose", async () => {
    await original();
    order.push("worker");
    throw Error("controlled worker cleanup failure");
  });
  for (const [name, target] of [
    ["supervisor", t.service.engine],
    ["terminal", t.service.terminals],
    ["browser", t.host.browser],
  ] as const) {
    const dispose = target.dispose.bind(target);
    ctx.mock.method(target, "dispose", async () => {
      order.push(name);
      await dispose();
    });
  }
  const close = t.service.store.close.bind(t.service.store);
  ctx.mock.method(t.service.store, "close", () => {
    order.push("store");
    close();
  });
  try {
    await assert.rejects(t.service.dispose(), /Engine\/worker cleanup failed/);
    for (const name of ["worker", "supervisor", "terminal", "browser", "store"])
      assert.ok(order.includes(name));
    assert.throws(() => t.service.store.read());
  } finally {
    ctx.mock.restoreAll();
    await fs.rm(t.dir, { recursive: true });
  }
});
test("Supervisor and worker cancellation failures are observed immediately and both branches settle", async (ctx) => {
  const t = await setup(),
    coordinator = (t.service as any).delegations;
  const state = t.service.engine.snapshot();
  let workerSettled = false;
  ctx.mock.method(t.service.engine, "snapshot", () => ({
    ...state,
    conversationId: "owner",
  }));
  ctx.mock.method(t.service.engine, "cancel", async () => {
    throw Error("controlled immediate supervisor cancellation failure");
  });
  ctx.mock.method(coordinator, "list", () => [
    { id: "task", status: "running" },
  ]);
  ctx.mock.method(coordinator, "cancel", async () => {
    await new Promise((r) => setTimeout(r, 20));
    workerSettled = true;
    throw Error("controlled worker cancellation failure");
  });
  try {
    const result = await t.service.api.engineCancel();
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error.message, /cancellation failed/);
    assert.equal(workerSettled, true);
  } finally {
    ctx.mock.restoreAll();
    await t.cleanup();
  }
});
test("Terminal snapshot saves partial output and cold Core history cannot erase it", async () => {
  const t = await setup();
  try {
    const c = t.service.store.conversation(null);
    t.service.store.update((s) => {
      s.conversations.find((v) => v.id === c.id)!.binding = {
        threadId: "owned-thread",
        sessionId: "owned-session",
        model: "test",
        endpoint: "http://127.0.0.1:9999/codex/v1",
        cwd: t.project,
      };
    });
    const partial = {
      id: "partial-a",
      type: "agentMessage" as const,
      text: "Retain this actual delta",
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    };
    const snapshot = {
      ...emptyEngine,
      conversationId: c.id,
      threadId: "owned-thread",
      turnId: "owned-turn",
      status: "failed" as const,
      items: [partial],
    };
    const persist = (event: EventEnvelope["event"]) =>
      (
        t.service as unknown as { persistEngine(e: EventEnvelope): void }
      ).persistEngine({
        conversationId: c.id,
        sequence: 1,
        at: Date.now(),
        simulated: false,
        event,
      });
    persist({ kind: "snapshot", snapshot });
    let stored = t.service.store
      .read()
      .conversations.find((v) => v.id === c.id)!;
    assert.equal(stored.messages[0].text, partial.text);
    assert.equal(stored.messages[0].incomplete, true);
    persist({
      kind: "history",
      threadId: "owned-thread",
      items: [{ ...partial, text: "" }],
    });
    stored = t.service.store.read().conversations.find((v) => v.id === c.id)!;
    assert.equal(stored.messages.length, 1);
    assert.equal(stored.messages[0].text, partial.text);
    const timeline = conversationTimeline(stored, {
      ...snapshot,
      items: [{ ...partial, text: "" }],
    });
    assert.equal(timeline[0].type, "message");
    if (timeline[0].type === "message")
      assert.deepEqual(timeline[0].message, stored.messages[0]);
    persist({
      kind: "history",
      threadId: "foreign-thread",
      items: [{ ...partial, text: "foreign" }],
    });
    assert.equal(
      t.service.store.read().conversations.find((v) => v.id === c.id)!
        .messages[0].text,
      partial.text,
    );
  } finally {
    await t.cleanup();
  }
});
test("Every exposed operation is validated, including unknown methods and extra fields", () => {
  assert.throws(() => validateOperation("__proto__", []));
  assert.throws(() => validateOperation("shell.execute", ["anything"]));
  assert.throws(() => validateOperation("state", [1]));
  assert.throws(() => validateOperation("preferences", [{ profile: "fast" }]));
  assert.throws(() => validateOperation("terminalResize", ["id", 0, 24]));
  assert.throws(() =>
    validateOperation("browserLayout", [
      "id",
      { x: NaN, y: 0, width: 1, height: 1 },
    ]),
  );
  assert.throws(() =>
    validateOperation("saveFile", [
      "id",
      { path: "x", content: "y", revision: "no", execute: "bad" },
    ]),
  );
  assert.ok(Object.keys(operationSchemas).includes("terminalWrite"));
});
test("Image operations persist owned drafts, reject cross-conversation reads and simulator substitution, and remove exact draft bytes", async () => {
  const f = await setup();
  try {
    const c = value(await f.service.api.newConversation(null)),
      other = value(await f.service.api.newConversation(null));
    const dataUrl =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jZioAAAAASUVORK5CYII=";
    const saved = value(
      await f.service.api.imageAttach(c.id, { name: "scene.png", dataUrl }),
    );
    const image = saved.conversations.find((v) => v.id === c.id)!
      .attachments![0];
    assert.equal(
      value(await f.service.api.imageRead(c.id, image.id)).dataUrl,
      dataUrl,
    );
    assert.equal((await f.service.api.imageRead(other.id, image.id)).ok, false);
    assert.equal((await f.service.api.engineStart(c.id, "", "text")).ok, false);
    assert.deepEqual(
      f.service.store.read().conversations.find((v) => v.id === c.id)!
        .draftImageIds,
      [image.id],
    );
    value(await f.service.api.imageRemove(c.id, image.id));
    assert.equal((await f.service.api.imageRead(c.id, image.id)).ok, false);
    assert.equal((await f.service.api.engineStart(c.id, "", "text")).ok, false);
  } finally {
    await f.cleanup();
  }
});
test("Service workspace edit, preset export/import, and structured errors use the validated boundary", async () => {
  const f = await setup();
  try {
    assert.deepEqual(
      Object.keys(f.service.api).sort(),
      Object.keys(operationSchemas).sort(),
    );
    const workspace = value(await f.service.api.chooseWorkspace())!;
    const read = value(await f.service.api.readFile(workspace.id, "note.txt"));
    const saved = value(
      await f.service.api.saveFile(workspace.id, {
        ...read,
        content: "saved locally",
      }),
    );
    assert.equal(saved.content, "saved locally");
    assert.equal(
      (await f.service.invoke("readFile", [workspace.id, "../state.sqlite"]))
        .ok,
      false,
    );
    const unknown = await f.service.invoke("nonexistent", []);
    assert.equal(unknown.ok, false);
    if (!unknown.ok) assert.equal(unknown.error.code, "INVALID_OPERATION");
    const preset = {
      schema: "synora.bot.v1",
      name: "Reviewer",
      description: "",
      instructions: "Inspect",
      kind: "coding",
      profile: "medium",
      context: 262144,
      connectorIds: [],
      enabled: true,
    };
    const state = value(
      await f.service.invoke("presetSave", [preset, undefined]),
    ) as { presets: Array<{ id: string }> };
    const id = state.presets[0].id;
    assert.equal(value(await f.service.api.presetExport(id)), true);
    value(await f.service.api.presetDelete(id));
    const imported = value(await f.service.api.presetImport())!;
    assert.equal(imported.presets[0].name, "Reviewer");
    assert.notEqual(imported.presets[0].id, id);
    const bad = await f.service.invoke("presetSave", [
      { ...preset, command: "forbidden" },
      undefined,
    ]);
    assert.equal(bad.ok, false);
  } finally {
    await f.cleanup();
  }
});
test("Disconnected turns persist and replay does not duplicate messages; agent history is retained", async () => {
  const f = await setup();
  try {
    const conversation = value(await f.service.api.newConversation(null));
    value(
      await f.service.api.engineStart(conversation.id, "Hello", "disconnect"),
    );
    await until(() => f.service.engine.snapshot().status === "completed");
    let stored = value(await f.service.api.state());
    assert.equal(stored.conversations[0].messages.length, 2);
    assert.equal(f.service.engine.snapshot().connection, "disconnected");
    value(await f.service.api.engineReconnect(0));
    value(await f.service.api.engineReconnect(0));
    stored = value(await f.service.api.state());
    assert.equal(stored.conversations[0].messages.length, 2);
    value(await f.service.api.engineStart(conversation.id, "Agents", "agents"));
    await until(() => f.service.engine.snapshot().status === "completed");
    stored = value(await f.service.api.state());
    assert.equal(stored.agentHistory.length, 2);
    assert.ok(
      stored.agentHistory.every(
        (a) => a.status === "completed" && a.parentId === conversation.id,
      ),
    );
    let reduced = emptyEngine;
    for (const e of f.events)
      if (e.kind === "engine") reduced = reduceEngine(reduced, e.data);
    assert.equal(reduced.status, "completed");
    assert.equal(reduced.turnId, f.service.engine.snapshot().turnId);
    const last = f.events.filter((e) => e.kind === "engine").at(-1)!;
    if (last.kind === "engine")
      assert.deepEqual(reduceEngine(reduced, last.data), reduced);
  } finally {
    await f.cleanup();
  }
});
test("Real PTY accepts input, resizes, reports exit and terminates only its owned process", async () => {
  const f = await setup();
  try {
    const before = value(await f.service.api.metrics());
    assert.ok(before.rssBytes > 0 && before.uptimeSeconds >= 0);
    assert.equal(before.terminalCount, 0);
    assert.equal(before.browserCount, 0);
    assert.equal(before.gpu, null);
    assert.equal(before.tokens, null);
    assert.ok(Math.abs(Date.now() - before.observedAt) < 1000);
    const workspace = value(await f.service.api.chooseWorkspace())!,
      terminal = value(await f.service.api.terminalOpen(workspace.id));
    assert.equal(value(await f.service.api.metrics()).terminalCount, 1);
    assert.ok(terminal.pid > 0);
    value(await f.service.api.terminalResize(terminal.id, 110, 28));
    value(
      await f.service.api.terminalWrite(
        terminal.id,
        terminalMarker("SYNORA_PTY_RESULT", 7) + "\r",
      ),
    );
    await until(() => f.service.terminals.list()[0].status === "exited");
    const info = f.service.terminals.list()[0];
    assert.equal(info.exitCode, 7);
    assert.equal(value(await f.service.api.metrics()).terminalCount, 0);
    assert.ok(info.output.includes("SYNORA_PTY_RESULT"));
    assert.ok(info.sequence > 0);
    const second = value(await f.service.api.terminalOpen(workspace.id));
    value(await f.service.api.terminalWrite(second.id, terminalSleep + "\r"));
    await new Promise((r) => setTimeout(r, 70));
    value(await f.service.api.terminalClose(second.id));
    assert.equal(f.service.terminals.list()[1].status, "exited");
    assert.throws(() => process.kill(second.pid, 0));
    assert.equal(value(await f.service.api.metrics()).terminalCount, 0);
    const events = f.events.filter(
      (e) => e.kind === "terminal" && e.id === terminal.id,
    );
    assert.deepEqual(
      events.map((e) => (e.kind === "terminal" ? e.sequence : 0)),
      events.map((_, i) => i + 1),
    );
  } finally {
    await f.cleanup();
  }
});
