import test from "node:test";
import assert from "node:assert/strict";
import { reduceEngine, emptyEngine } from "../src/renderer/engine-state";
import type { EventEnvelope } from "../src/shared/contracts";
test("Streaming renderer receives first-text time and usage before final snapshot, ignores other identities", () => {
  let state = { ...emptyEngine };
  let sequence = 0;
  const send = (method: string, params: unknown, at: number) => {
    state = reduceEngine(state, {
      sequence: ++sequence,
      at,
      simulated: false,
      event: { kind: "protocol", payload: { method, params } },
    } as EventEnvelope);
  };
  send(
    "turn/started",
    { threadId: "thread", turn: { id: "turn", items: [] } },
    1000,
  );
  send(
    "item/started",
    {
      threadId: "thread",
      turnId: "turn",
      item: {
        type: "agentMessage",
        id: "m",
        text: "",
        phase: null,
        memoryCitation: null,
        delivery: null,
        questions: null,
      },
    },
    1200,
  );
  send(
    "item/agentMessage/delta",
    { threadId: "thread", turnId: "turn", itemId: "m", delta: "hello" },
    1250,
  );
  assert.equal(state.firstDeltaAt, 1250);
  assert.equal(state.startedAt, 1000);
  const tokenUsage = {
    last: {
      inputTokens: 10,
      outputTokens: 2,
      reasoningOutputTokens: 1,
      totalTokens: 12,
      cachedInputTokens: 0,
    },
    total: {},
    modelContextWindow: null,
  };
  send("thread/tokenUsage/updated", { threadId: "other", tokenUsage }, 1300);
  assert.equal(state.tokenUsage, undefined);
  send("thread/tokenUsage/updated", { threadId: "thread", tokenUsage }, 1400);
  assert.deepEqual(state.tokenUsage, tokenUsage);
  send(
    "turn/completed",
    {
      threadId: "thread",
      turn: { id: "turn", status: "completed", items: [] },
    },
    1600,
  );
  assert.equal(state.completedAt, 1600);
});
