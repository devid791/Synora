import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { validateOperation } from "../src/shared/operations";

test("Both panel preferences validate, persist independently and preserve session state", () => {
  const dir = mkdtempSync(join(tmpdir(), "synora-panel-layout-"));
  let store: Store | undefined;
  try {
    const file = join(dir, "state.sqlite");
    store = new Store(file);
    const c = store.conversation(null);
    store.draft(c.id, "KEEP_DRAFT");
    const original = store.read();
    assert.equal(original.preferences.sidebarCollapsed, false);
    assert.equal(original.preferences.filesCollapsed, false);
    for (const patch of [
      { sidebarCollapsed: true },
      { filesCollapsed: true },
    ]) {
      validateOperation("preferences", [patch]);
      store.preferences(patch);
    }
    store.close();
    store = new Store(file);
    assert.equal(store.read().preferences.sidebarCollapsed, true);
    assert.equal(store.read().preferences.filesCollapsed, true);
    store.preferences({ filesCollapsed: false });
    assert.equal(store.read().preferences.sidebarCollapsed, true);
    assert.deepEqual(store.read().conversations, original.conversations);
    assert.deepEqual(store.read().engine, original.engine);
    assert.equal(
      store.read().preferences.permission,
      original.preferences.permission,
    );
    for (const invalid of [
      { sidebarCollapsed: "yes" },
      { filesCollapsed: 1 },
      { collapsed: true },
    ]) {
      assert.throws(() => validateOperation("preferences", [invalid]));
      assert.throws(() => store!.preferences(invalid));
    }
    assert.equal(store.read().preferences.filesCollapsed, false);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
