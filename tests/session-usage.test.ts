import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/main/store";
import {
  captureUsage,
  emptyUsage,
  sessionUsageSchema,
} from "../src/shared/session-usage";
import { contextView } from "../src/renderer/ContextUsage";
import { emptyEngine } from "../src/renderer/engine-state";
const first = {
  ...emptyUsage(),
  totalTokens: 105,
  inputTokens: 100,
  outputTokens: 5,
};
const next = {
  ...emptyUsage(),
  totalTokens: 320,
  inputTokens: 310,
  outputTokens: 10,
};
test("Core context, cumulative consumption and turn consumption remain distinct", () => {
  const value = {
    total: next,
    last: {
      ...emptyUsage(),
      totalTokens: 215,
      inputTokens: 210,
      outputTokens: 5,
    },
    modelContextWindow: 1000,
  };
  const a = captureUsage("thread", "turn2", value, 10, first);
  assert.equal(a.turn?.totalTokens, 215);
  assert.equal(a.value.total.totalTokens, 320);
  const view = contextView({ ...emptyEngine, usage: a });
  assert.equal(view.used, 215);
  assert.deepEqual(captureUsage("thread", "turn2", value, 10, first), a);
  assert.equal(captureUsage("thread", "restored", value, 12).turn, undefined);
  assert.equal(
    captureUsage("thread", "reset", { ...value, total: first }, 13, next).turn,
    undefined,
  );
});
test("Missing, malformed and compacting counters are not invented", () => {
  assert.equal(contextView(emptyEngine, 262144).used, null);
  assert.equal(
    sessionUsageSchema.safeParse({ value: { total: { totalTokens: -1 } } })
      .success,
    false,
  );
});
test("Actual usage persists across store restart independently of UI and Axiom KV", () => {
  const dir = mkdtempSync(join(tmpdir(), "synora-usage-"));
  let store: Store | undefined;
  try {
    const path = join(dir, "state.sqlite");
    store = new Store(path);
    const c = store.conversation(null);
    const usage = captureUsage(
      "t",
      "u",
      { total: first, last: first, modelContextWindow: 262144 },
      100,
      emptyUsage(),
    );
    store.update((s) => {
      s.conversations.find((x) => x.id === c.id)!.usage = usage;
    });
    store.close();
    store = new Store(path);
    assert.deepEqual(store.read().conversations[0].usage, usage);
  } finally {
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
