import test from "node:test";
import assert from "node:assert/strict";
import type { AppState, AgentRecord } from "../src/shared/contracts";
import { emptyEngine } from "../src/renderer/engine-state";
import {
  closeSide,
  emptySplitView,
  openSide,
  parseSplitView,
  pruneSplitView,
  reportedEntries,
  sideExists,
  sideKey,
  sideSources,
} from "../src/renderer/split-view-state";
test("Split layout storage is bounded, credential/content-free, validated and tolerant of corrupt storage", () => {
  for (const value of [
    null,
    "{",
    "null",
    "[]",
    JSON.stringify({ tabs: Array(13).fill({ kind: "agent", id: "a" }) }),
  ])
    assert.deepEqual(parseSplitView(value), emptySplitView());
  const result = parseSplitView(
    JSON.stringify({
      visible: true,
      width: 999,
      selected: "unknown",
      tabs: [
        { kind: "agent", id: "a", text: "NEVER_STORE" },
        { kind: "agent", id: "a" },
        { kind: "task", id: "t" },
        { kind: "invalid", id: "a" },
        { kind: "conversation", id: "c" },
      ],
    }),
  );
  assert.equal(result.width, 65);
  assert.equal(result.tabs.length, 2);
  assert.equal(result.selected, sideKey(result.tabs[0]));
  assert.ok(!JSON.stringify(result).includes("NEVER_STORE"));
});
test("Tabs retain exact kind/parent identity, select existing tabs without duplication, and never evict at limit", () => {
  let value = emptySplitView();
  for (let i = 0; i < 12; i++)
    value = openSide(value, { kind: "agent", id: String(i) });
  const full = structuredClone(value);
  value = openSide(value, { kind: "agent", id: "overflow" });
  assert.deepEqual(value.tabs, full.tabs);
  assert.equal(value.selected, full.selected);
  value = openSide(value, { kind: "agent", id: "3" });
  assert.equal(value.tabs.length, 12);
  assert.equal(value.selected, sideKey({ kind: "agent", id: "3" }));
  assert.notEqual(
    sideKey({ kind: "agent", id: "same" }),
    sideKey({ kind: "conversation", id: "same" }),
  );
  assert.notEqual(
    sideKey({ kind: "task", id: "same", parentId: "p1" }),
    sideKey({ kind: "task", id: "same", parentId: "p2" }),
  );
  value = closeSide(value, value.selected);
  assert.equal(value.tabs.length, 11);
  assert.equal(value.selected, sideKey({ kind: "agent", id: "4" }));
});
test("Reading sources merges current child activity without duplicating agents or inventing a task association", () => {
  const old: AgentRecord = {
    id: "a",
    name: "Luna",
    parentId: "p",
    task: "Read",
    status: "running",
    result: "Old",
    simulated: false,
  };
  const state = {
    agentHistory: [old],
    conversations: [],
    delegations: [],
  } as unknown as AppState;
  const sources = sideSources(state, {
    ...emptyEngine,
    agents: [{ ...old, result: "Fresh" }],
  });
  assert.equal(sources.agents.length, 1);
  assert.equal(sources.agents[0].result, "Fresh");
  assert.equal(old.result, "Old");
  assert.equal(
    sideExists({ kind: "task", id: "a", parentId: "p" }, sources),
    false,
  );
  const view = openSide(
    openSide(emptySplitView(), { kind: "agent", id: "a" }),
    { kind: "conversation", id: "deleted" },
  );
  const cleaned = pruneSplitView(view, sources);
  assert.equal(cleaned.tabs.length, 1);
  assert.equal(cleaned.selected, sideKey({ kind: "agent", id: "a" }));
});
test("Reported activity preserves original IDs/order/text, latest same-ID updates, and unknown raw content", () => {
  const result = reportedEntries([
    {
      type: "userMessage",
      id: "u",
      content: [
        { type: "text", text: "Read only 🦉" },
        { type: "image", url: "untrusted" },
      ],
    },
    { type: "agentMessage", id: "a", text: "first" },
    {
      type: "commandExecution",
      id: "tool",
      aggregatedOutput: "<script>NOT_EXECUTED</script>",
    },
    { type: "agentMessage", id: "a", text: "first and second" },
    null,
  ]);
  assert.deepEqual(
    result.map((v) => v.id),
    ["u", "a", "tool", "unidentified-4"],
  );
  assert.equal(result[0].text, "Read only 🦉");
  assert.equal(result[1].text, "first and second");
  assert.equal(result[2].kind, "activity");
  assert.equal(result[4], undefined);
  assert.equal(result[3].raw, null);
  assert.equal(
    (result[2].raw as { aggregatedOutput: string }).aggregatedOutput,
    "<script>NOT_EXECUTED</script>",
  );
});
