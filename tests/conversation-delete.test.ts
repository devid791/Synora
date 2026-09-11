import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalService, type Host } from "../src/main/service";
import type { Result } from "../src/shared/contracts";
const value = <T>(r: Result<T>): T => { if (!r.ok) throw Error(r.error.message); return r.value; };
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "synora-delete-owned-"));
  const host: Host = { closeReady() {}, chooseWorkspace: async () => null, importPreset: async () => null, exportPreset: async () => false,
    capabilities: { platform: "web", transport: "local-http", nativeDialogs: false, terminal: false, embeddedBrowser: false, engine: "simulated", liveInference: false },
    browser: { open: () => [], navigate() {}, action: () => [], layout() {}, list: () => [], dispose() {} } };
  const service = new LocalService(join(dir, "state.sqlite"), host, () => {}, 1, { disabledReason: "Owned deletion fixture" });
  service.store.preferences({ botCatalogAutomatic: false, pluginCatalogAutomatic: false });
  const target = service.store.conversation(null), keep = service.store.conversation(null);
  const image = value(await service.api.imageAttach(target.id, { name: "Owned fixture.png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }));
  const registered = service.store.read().conversations.find(c => c.id === target.id)!.attachments![0];
  const file = (service as any).images.path(target.id, registered) as string;
  return { dir, service, target, keep, image, file, cleanup: async () => { await service.dispose(); await rm(dir, { recursive: true }); } };
}
test("Confirmed deletion removes only owned history/attachments; project file and other draft survive", async () => {
  const f = await setup();
  try {
    const project = join(f.dir, "user-project.txt"); await writeFile(project, "untouched");
    f.service.store.draft(f.keep.id, "Retain my draft");
    const before = f.service.store.read().conversations.find(c => c.id === f.keep.id);
    assert.equal((await f.service.api.conversationDelete(f.target.id, false as true)).ok, false);
    const result = value(await f.service.api.conversationDelete(f.target.id, true));
    assert.equal(result.cleanupWarning, undefined);
    assert.ok(!result.state.conversations.some(c => c.id === f.target.id));
    assert.deepEqual(result.state.conversations.find(c => c.id === f.keep.id), before);
    await assert.rejects(access(f.file)); assert.equal(await readFile(project, "utf8"), "untouched");
    assert.equal((await f.service.api.conversationDelete(f.target.id, true)).ok, false);
  } finally { await f.cleanup(); }
});
test("Failed SQLite deletion restores staged attachments and retains all conversation data", async ctx => {
  const f = await setup();
  try {
    const before = f.service.store.read(), bytes = await readFile(f.file);
    ctx.mock.method(f.service.store, "conversationDelete", () => { throw Error("Controlled database failure"); });
    const result = await f.service.api.conversationDelete(f.target.id, true);
    assert.equal(result.ok, false); assert.deepEqual(f.service.store.read(), before); assert.deepEqual(await readFile(f.file), bytes);
  } finally { await f.cleanup(); }
});
test("Busy/cleanup and corrupt-attachment guards reject deletion without removing the chat", async ctx => {
  const f = await setup();
  try {
    const snapshot = f.service.engine.snapshot();
    const mock = ctx.mock.method(f.service.engine, "snapshot", () => ({ ...snapshot, status: "running" as const, conversationId: f.target.id }));
    assert.equal((await f.service.api.conversationDelete(f.target.id, true)).ok, false); await access(f.file);
    mock.mock.restore();
    await writeFile(f.file, "changed");
    assert.equal((await f.service.api.conversationDelete(f.target.id, true)).ok, false);
    assert.ok(f.service.store.read().conversations.some(c => c.id === f.target.id));
    assert.equal(await readFile(f.file, "utf8"), "changed");
  } finally { await f.cleanup(); }
});
test("Interrupted deletion restores pre-commit images and purges post-commit images at recovery", async () => {
  const f = await setup();
  try {
    const images = (f.service as any).images;
    const target = f.service.store.read().conversations.find(c => c.id === f.target.id)!;
    const original = await readFile(f.file);
    await images.stageConversationRemoval(target.id, target.attachments);
    await assert.rejects(access(f.file));
    images.recoverConversationRemovals(new Set(f.service.store.read().conversations.map(c => c.id)));
    assert.deepEqual(await readFile(f.file), original);
    await images.stageConversationRemoval(target.id, target.attachments);
    f.service.store.conversationDelete(target.id);
    images.recoverConversationRemovals(new Set(f.service.store.read().conversations.map(c => c.id)));
    await assert.rejects(access(f.file));
    images.recoverConversationRemovals(new Set([f.keep.id]));
  } finally { await f.cleanup(); }
});
