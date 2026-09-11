import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { conversationGroups, conversationTranscript } from "../src/shared/conversation-management";
import { validateOperation } from "../src/shared/operations";
import type { Conversation } from "../src/shared/contracts";

test("Chat metadata and sidebar settings survive SQLite cold reopen without changing source identity/history/draft/cwd", () => {
  const dir = mkdtempSync(join(tmpdir(), "synora-chat-management-")), path = join(dir, "state.sqlite");
  let store = new Store(path);
  try {
    const w = store.addWorkspace(dir, "Original"), second = store.addWorkspace(join(dir, "another-project"), "Another");
    const c = store.conversation(w.id);
    store.update(s => {
      const v = s.conversations[0];
      v.binding = { threadId: "thread-real", sessionId: "session-real", endpoint: "https://fixture.invalid", model: "fixture", cwd: w.path };
      v.messages = [{ id: "message-real", role: "user", text: "Original saved text", simulated: false }];
      v.draft = "Unsent original draft"; v.itemOrder = ["message-real"];
    });
    const before = store.read().conversations[0];
    store.conversationUpdate(c.id, { title: "Renamed", pinned: true, unread: true, archived: true, projectId: second.id });
    store.preferences({ conversationGrouping: "project", conversationSort: "title" });
    store.close(); store = new Store(path);
    const after = store.read().conversations[0];
    for (const key of ["id", "createdAt", "workspaceId", "binding", "messages", "draft", "activity", "itemOrder", "defaults"] as const) assert.deepEqual(after[key], before[key], key);
    assert.equal(after.title, "Renamed"); assert.equal(after.titleEdited, true);
    assert.equal(after.projectId, second.id); assert.equal(after.pinned, true); assert.equal(after.archived, true); assert.equal(after.unread, true);
    assert.equal(store.read().preferences.conversationGrouping, "project"); assert.equal(store.read().preferences.conversationSort, "title");
    store.conversationUpdate(c.id, { archived: false });
    assert.equal(store.read().conversations.length, 1);
    assert.throws(() => store.conversationUpdate(c.id, { projectId: "unknown" }));
    assert.throws(() => store.conversationUpdate("unknown", { title: "Wrong" }));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test("Named metadata operations reject empty/invalid/identity mutations; fork requires explicit confirmation", () => {
  for (const patch of [{}, { title: " " }, { title: "x".repeat(161) }, { title: "a\nb" }, { pinned: "yes" }, { binding: {} }, { messages: [] }, { workspaceId: "new" }, { updatedAt: 0 }])
    assert.throws(() => validateOperation("conversationUpdate", ["conversation", patch]));
  assert.throws(() => validateOperation("conversationForkDraft", ["conversation", false]));
  for (const args of [["conversation"], ["conversation", false], ["conversation", "true"], ["", true]])
    assert.throws(() => validateOperation("conversationDelete", args));
  assert.deepEqual(validateOperation("conversationDelete", ["conversation", true]).args, ["conversation", true]);
  assert.throws(() => validateOperation("preferences", [{ conversationSort: "invented" }]));
  assert.throws(() => validateOperation("preferences", [{ conversationGrouping: "all-project-files" }]));
});
test("Permanent deletion is exact, removes owned agent history, preserves forks and survives cold reopen", () => {
  const dir = mkdtempSync(join(tmpdir(), "synora-chat-delete-")), path = join(dir, "state.sqlite");
  let store = new Store(path);
  try {
    const keep = store.conversation(null), target = store.conversation(null);
    store.update(s => {
      const c = s.conversations.find(c => c.id === target.id)!; c.archived = true; c.draft = "Deleted draft";
      c.messages = [{ id: "delete-message", role: "user", text: "Deleted text", simulated: true }];
      s.agentHistory = [{ id: "child", parentId: target.id, name: "Owned", task: "Controlled", result: "Done", status: "completed", closed: true, simulated: true },
        { id: "grandchild", parentId: "child", name: "Nested", task: "Controlled", result: "Done", status: "completed", closed: true, simulated: true }];
    });
    const fork = store.conversationForkDraft(target.id), before = store.read();
    store.conversationDelete(target.id);
    store.close(); store = new Store(path);
    const after = store.read(); assert.ok(!after.conversations.some(c => c.id === target.id));
    assert.deepEqual(after.agentHistory, []);
    for (const id of [keep.id, fork.id]) assert.deepEqual(after.conversations.find(c => c.id === id), before.conversations.find(c => c.id === id));
    assert.throws(() => store.conversationDelete(target.id));
    store.conversationDelete(keep.id); store.conversationDelete(fork.id);
    assert.deepEqual(store.read().conversations, []);
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
test("Pinned sorting, archived filtering and project grouping include every chat, without mutating input", () => {
  const entries = Array.from({ length: 75 }, (_, i) => ({ id: `c${i}`, title: `${i === 0 ? "Z" : "A"}${i}`, createdAt: i, updatedAt: 100 - i,
    pinned: i === 0, archived: i === 1, workspaceId: i % 2 ? "w1" : "w2", draft: "", messages: [], activity: [], itemOrder: [] } satisfies Conversation));
  const before = structuredClone(entries), projects = [{ id: "w1", name: "First", path: "/first" }, { id: "w2", name: "Second", path: "/second" }];
  for (const sort of ["created", "updated", "title"] as const) {
    const groups = conversationGroups(entries, projects, "project", sort);
    assert.equal(groups.flatMap(g => g.conversations).length, 74);
    assert.equal(groups[0].conversations[0].id, "c0");
    const list = conversationGroups(entries, projects, "list", sort);
    assert.equal(list.length, 1); assert.equal(list[0].conversations[0].id, "c0");
  }
  assert.equal(conversationGroups(entries, projects, "list", "updated", true)[0].conversations[0].id, "c1");
  assert.deepEqual(entries, before);
});
test("Text fork is a new unsent draft, never a fabricated Core/history clone; source and existing draft survive", () => {
  const dir = mkdtempSync(join(tmpdir(), "synora-chat-fork-")), store = new Store(join(dir, "state.sqlite"));
  try {
    const source = store.conversation(null);
    store.update(s => { const c = s.conversations[0]; c.draft = "Original private draft";
      c.messages = [{ id: "user1", role: "user", text: "Original request", simulated: false }, { id: "assistant1", role: "assistant", text: "Saved answer", simulated: false }]; });
    const before = store.read().conversations[0];
    const fork = store.conversationForkDraft(source.id);
    assert.notEqual(fork.id, source.id); assert.equal(fork.forkedFrom, source.id);
    assert.equal(fork.draft, conversationTranscript(before)); assert.equal(fork.binding, undefined);
    assert.deepEqual(fork.messages, []); assert.deepEqual(fork.activity, []);
    assert.deepEqual(store.read().conversations.find(c => c.id === source.id), before);
    assert.throws(() => store.conversationForkDraft(fork.id));
    store.update(s => { s.conversations.find(c => c.id === source.id)!.messages[0].incomplete = true; });
    assert.throws(() => store.conversationForkDraft(source.id));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});
