import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  DelegationCoordinator,
  type DelegationTask,
  type DelegationReviewInput,
} from "../src/engine/delegation-coordinator";
import { delegationTools } from "../src/engine/delegation-tools";

const owner = "owner";
const request = (callId = "original-call") => ({
  name: "Reader",
  workerId: "reader",
  parentConversationId: owner,
  parentThreadId: "parent/thread",
  parentTurnId: "parent/turn",
  callId,
  task: "Read the task",
  timeoutMs: 10000,
});
const decision = (
  verdict: DelegationReviewInput["verdict"] = "accepted",
  callId = "review/call",
): DelegationReviewInput => ({
  verdict,
  summary: "Checked the exact returned evidence.\n No inferred work.",
  parentThreadId: "parent/thread",
  parentTurnId: "review/turn",
  callId,
});
function harness(t: TestContext, loaded: DelegationTask[] = []) {
  let saved = structuredClone(loaded),
    failSave = false,
    runs = 0;
  const c = new DelegationCoordinator({
    load: () => saved,
    save: (tasks) => {
      if (failSave) throw Error("disk unavailable");
      saved = structuredClone(tasks);
    },
    execute: async () => {
      runs++;
      return { result: "Exact worker evidence" };
    },
  });
  t.after(() => c.dispose());
  return {
    c,
    saved: () => structuredClone(saved),
    runs: () => runs,
    failSave: (value: boolean) => {
      failSave = value;
    },
  };
}
async function completed(c: DelegationCoordinator, callId = "original-call") {
  const task = c.start(request(callId));
  const done = await c.wait(task.id, owner, 1000);
  assert.equal(done.status, "completed");
  return done;
}

test("Review records original supervisor identity, does not rerun work, and survives cold restoration", async (t) => {
  const h = harness(t),
    task = await completed(h.c),
    review = h.c.review(task.id, owner, decision());
  assert.equal(review.status, "completed");
  assert.equal(review.result, task.result);
  assert.equal(review.callId, task.callId);
  assert.equal(review.review?.callId, "review/call");
  assert.equal(review.review?.summary, decision().summary);
  assert.ok(review.review?.at);
  assert.equal(h.runs(), 1);
  const cold = harness(t, h.saved());
  assert.deepEqual(cold.c.get(task.id, owner), review);
  assert.equal(cold.runs(), 0);
});

test("Review is idempotent for exact replay; contradictory identity or decision cannot overwrite it", async (t) => {
  const h = harness(t),
    task = await completed(h.c),
    first = h.c.review(task.id, owner, decision());
  assert.deepEqual(h.c.review(task.id, owner, decision()), first);
  for (const patch of [
    { verdict: "changes_requested" },
    { summary: "different" },
    { parentTurnId: "different" },
    { callId: "different" },
  ])
    assert.throws(
      () =>
        h.c.review(task.id, owner, {
          ...decision(),
          ...patch,
        } as DelegationReviewInput),
      /immutable/,
    );
  assert.deepEqual(h.c.get(task.id, owner), first);
});

test("Review rejects foreign owners/threads, blank or malformed decisions, and running tasks", async (t) => {
  const h = harness(t),
    queued = h.c.start(request());
  assert.throws(
    () => h.c.review(queued.id, owner, decision()),
    /Only completed/,
  );
  const task = await h.c.wait(queued.id, owner, 1000);
  assert.throws(() => h.c.review(task.id, "foreign", decision()), /not found/);
  assert.throws(
    () =>
      h.c.review(task.id, owner, { ...decision(), parentThreadId: "foreign" }),
    /same supervisor/,
  );
  for (const summary of ["", "  \n", "x".repeat(20001)])
    assert.throws(() => h.c.review(task.id, owner, { ...decision(), summary }));
  assert.throws(() =>
    h.c.review(task.id, owner, { ...decision(), at: 1 } as any),
  );
  assert.throws(() =>
    h.c.review(task.id, owner, { ...decision(), verdict: "approved" } as any),
  );
  assert.equal(h.c.get(task.id, owner).review, undefined);
});

test("Review call identity cannot collide with delegation or another task's review", async (t) => {
  const h = harness(t),
    first = await completed(h.c),
    second = await completed(h.c, "second-call");
  assert.throws(
    () => h.c.review(first.id, owner, decision("accepted", "original-call")),
    /another operation/,
  );
  h.c.review(first.id, owner, decision());
  assert.throws(
    () => h.c.review(second.id, owner, decision()),
    /another operation/,
  );
  assert.throws(() => h.c.start(request("review/call")), /belongs to a review/);
});

test("Unpersisted review is not reported as accepted and can be explicitly retried", async (t) => {
  const h = harness(t),
    task = await completed(h.c);
  h.failSave(true);
  assert.throws(
    () => h.c.review(task.id, owner, decision()),
    /disk unavailable/,
  );
  assert.equal(h.c.get(task.id, owner).review, undefined);
  assert.equal(h.saved()[0].review, undefined);
  h.failSave(false);
  assert.equal(
    h.c.review(task.id, owner, decision()).review?.verdict,
    "accepted",
  );
});

test("Changes-requested creates no work; explicit revision is linked, isolated and replay-safe", async (t) => {
  const h = harness(t),
    task = await completed(h.c);
  assert.throws(
    () => h.c.start({ ...request("revision"), revisesTaskId: task.id }),
    /changes-requested/,
  );
  const reviewed = h.c.review(task.id, owner, decision("changes_requested"));
  assert.equal(h.runs(), 1);
  const nextInput = {
    ...request("revision"),
    parentTurnId: "next/turn",
    task: "Address the review",
    revisesTaskId: task.id,
  };
  const next = h.c.start(nextInput);
  assert.notEqual(next.id, task.id);
  assert.equal(next.revisesTaskId, task.id);
  assert.equal((await h.c.wait(next.id, owner, 1000)).status, "completed");
  assert.equal(h.runs(), 2);
  assert.equal(h.c.start(nextInput).id, next.id);
  assert.throws(
    () => h.c.start({ ...nextInput, revisesTaskId: undefined }),
    /Conflicting/,
  );
  assert.deepEqual(h.c.get(task.id, owner), reviewed);
  const cold = harness(t, h.saved());
  assert.equal(cold.c.get(next.id, owner).revisesTaskId, task.id);
  assert.equal(cold.runs(), 0);
});

test("Accepted or foreign results cannot be silently revised", async (t) => {
  const h = harness(t),
    task = await completed(h.c);
  h.c.review(task.id, owner, decision());
  assert.throws(
    () => h.c.start({ ...request("revision"), revisesTaskId: task.id }),
    /changes-requested/,
  );
  assert.throws(
    () =>
      h.c.start({
        ...request("revision"),
        parentConversationId: "foreign",
        revisesTaskId: task.id,
      }),
    /not found/,
  );
  assert.throws(
    () =>
      h.c.start({
        ...request("revision"),
        parentThreadId: "foreign",
        revisesTaskId: task.id,
      }),
    /same supervisor/,
  );
});

test("Cold malformed review and revision identities are rejected rather than reconciled to a fake pass", async (t) => {
  const h = harness(t),
    task = await completed(h.c),
    reviewed = h.c.review(task.id, owner, decision());
  for (const bad of [
    { ...reviewed, status: "failed" },
    { ...reviewed, result: "" },
    { ...reviewed, review: { ...reviewed.review, parentThreadId: "foreign" } },
    { ...reviewed, review: { ...reviewed.review, callId: task.callId } },
    { ...task, revisesTaskId: task.id },
    { ...task, revisesTaskId: "absent" },
  ])
    assert.throws(() => harness(t, [bad as DelegationTask]), /Invalid durable/);
  const a = { ...task, status: "failed" as const, revisesTaskId: "second" },
    b = {
      ...task,
      id: "second",
      callId: "second-call",
      status: "failed" as const,
      revisesTaskId: task.id,
    };
  assert.throws(() => harness(t, [a, b]), /Cyclic/);
});

test("Original host call supplies review identity; tool arguments cannot override it", async (t) => {
  const h = harness(t),
    task = await completed(h.c);
  const tools = delegationTools(owner, [], h.c),
    base = {
      namespace: null,
      threadId: "parent/thread",
      turnId: "wire/turn",
      callId: "wire/call",
      tool: "synora_review",
    };
  const args = {
    task_id: task.id,
    verdict: "accepted",
    summary: "Checked original evidence",
  };
  await assert.rejects(
    tools.call(
      { ...base, arguments: { ...args, callId: "spoof" } },
      new AbortController().signal,
    ),
  );
  const response = await tools.call(
    { ...base, arguments: args },
    new AbortController().signal,
  );
  assert.equal(response.success, true);
  assert.equal(h.c.get(task.id, owner).review?.callId, "wire/call");
  assert.equal(h.c.get(task.id, owner).review?.parentTurnId, "wire/turn");
});
