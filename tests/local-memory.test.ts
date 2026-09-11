import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import { localCacheKiB } from "../src/shared/local-memory";
test("Local history cache stays bounded by physical RAM", () => {
  assert.equal(localCacheKiB("balanced", 16 * 1024 ** 3), 256 * 1024);
  assert.equal(localCacheKiB("expanded", 4 * 1024 ** 3), 256 * 1024);
});
test("Selector changes SQLite's actual target, persists, and never deletes history", () => {
  const dir = mkdtempSync(join(tmpdir(), "synora-memory-"));
  let store: Store | undefined;
  try {
    const path = join(dir, "state.sqlite");
    store = new Store(path);
    const c = store.conversation(null);
    store.draft(c.id, "Preserve my draft");
    for (const profile of ["expanded", "lean", "balanced"] as const) {
      store.preferences({ localMemory: profile });
      const status = store.memoryStatus();
      assert.equal(status.profile, profile);
      assert.equal(
        status.cacheTargetBytes,
        localCacheKiB(profile, status.physicalMemoryBytes) * 1024,
      );
      assert.equal(status.storageDirectory, dir);
      assert.ok(status.heapUsedBytes > 0);
      assert.equal(store.read().conversations[0].draft, "Preserve my draft");
    }
    assert.throws(() => store!.preferences({ localMemory: "invented" }));
    assert.equal(store.memoryStatus().profile, "balanced");
    store.close();
    store = new Store(path);
    assert.equal(store.memoryStatus().profile, "balanced");
    assert.equal(store.read().conversations[0].id, c.id);
    assert.equal(store.read().preferences.permission, "ask");
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
