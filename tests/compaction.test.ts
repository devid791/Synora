import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { updateCompactions } from "../src/shared/compaction";
import { parseNotification } from "../src/engine/protocol-validation";
import { Store } from "../src/main/store";
import { validateOperation } from "../src/shared/operations";

test("Compaction identity, deduplication and terminal state persist without erasing history or drafts", async () => {
  const note = (method: string, turnId = "turn-a") =>
    parseNotification({
      method,
      params: {
        threadId: "thread-a",
        turnId,
        item: { type: "contextCompaction", id: "compact-a" },
        ...(method === "item/started"
          ? { startedAtMs: 10 }
          : { completedAtMs: 20 }),
      },
    });
  let records = updateCompactions([], note("item/started"), 10);
  assert.equal(records[0].status, "running");
  records = updateCompactions(records, note("item/completed"), 20);
  assert.equal(records[0].status, "completed");
  assert.deepEqual(
    updateCompactions(records, note("item/started"), 30),
    records,
  );
  assert.deepEqual(
    updateCompactions(records, note("item/completed"), 40),
    records,
  );
  assert.equal(
    updateCompactions(records, note("item/started", "turn-b"), 50).length,
    2,
  );
  assert.throws(() =>
    validateOperation("engineCompact", ["owned", { threshold: 1 }]),
  );
  const dir = await mkdtemp(join(tmpdir(), "synora-compact-state-"));
  let store = new Store(join(dir, "state.sqlite"));
  try {
    store.conversation(null);
    store.update((s) => {
      s.conversations[0].compactions = records;
      s.conversations[0].draft = "unsent text";
      s.conversations[0].messages = [
        {
          id: "prior",
          role: "user",
          text: "retained history",
          simulated: false,
        },
      ];
    });
    store.close();
    store = new Store(join(dir, "state.sqlite"));
    assert.deepEqual(store.read().conversations[0].compactions, records);
    assert.equal(store.read().conversations[0].draft, "unsent text");
    assert.equal(
      store.read().conversations[0].messages[0].text,
      "retained history",
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true });
  }
});
