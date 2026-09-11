import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { workspaceOverlap } from "../src/main/workspace-lock";
import { resolve } from "node:path";
import {
  DelegationCoordinator,
  delegationTaskSchema,
  type DelegationCoordinatorOptions,
  type DelegationPublish,
  type DelegationStartInput,
  type DelegationTask,
} from "../src/engine/delegation-coordinator";

const input = (
  callId = "call_exact/é:001",
  overrides: Partial<DelegationStartInput> = {},
): DelegationStartInput => ({
  name: "Controlled worker",
  workerId: "configured-worker",
  parentConversationId: "owner-conversation",
  parentThreadId: "parent/thread:exact",
  parentTurnId: "parent/turn:exact",
  callId,
  task: "Keep this exact task text.\n  Including whitespace.  ",
  timeoutMs: 10_000,
  ...overrides,
});
const owner = input().parentConversationId;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
// A finite microtask flush, never provider polling or wall-clock sleeps.
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

function harness(
  t: TestContext,
  queueConcurrency?: number,
  loaded: DelegationTask[] = [],
  resourceKey?: DelegationCoordinatorOptions["resourceKey"],
  resourcesConflict?: DelegationCoordinatorOptions["resourcesConflict"],
) {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 1_000 });
  const runs: {
    task: DelegationTask;
    signal: AbortSignal;
    publish: DelegationPublish;
    outcome: ReturnType<typeof deferred<{ result: string }>>;
    cleaned: boolean;
  }[] = [];
  const saves: DelegationTask[][] = [];
  const changes: DelegationTask[][] = [];
  const coordinator = new DelegationCoordinator({
    load: () => loaded,
    save: (tasks) => {
      saves.push(structuredClone(tasks));
    },
    onChange: (tasks) => {
      changes.push(tasks);
    },
    queueConcurrency,
    resourceKey,
    resourcesConflict,
    execute: async (task, signal, publish) => {
      const run = {
        task,
        signal,
        publish,
        outcome: deferred<{ result: string }>(),
        cleaned: false,
      };
      runs.push(run);
      try {
        return await run.outcome.promise;
      } finally {
        run.cleaned = true;
      }
    },
  });
  t.after(async () => {
    const disposal = coordinator.dispose();
    for (const run of runs)
      run.outcome.resolve({ result: "controlled test cleanup" });
    await disposal;
  });
  return { coordinator, runs, saves, changes };
}

// The durable schema intentionally excludes the start-only timeoutMs option.
const stored = (
  status: DelegationTask["status"],
  suffix = status,
): DelegationTask => {
  const { timeoutMs: _timeout, ...request } = input(`cold-${suffix}`);
  return {
    ...request,
    id: `durable-${suffix}`,
    status,
    createdAt: 100,
    updatedAt: 110,
    deadlineAt: 10_100,
    result: "retained partial or final result",
  };
};

test("Strict durable schema derives the task shape and rejects unknown credential/status fields", () => {
  const task = stored("queued");
  assert.deepEqual(delegationTaskSchema.parse(task), task);
  assert.equal(
    delegationTaskSchema.safeParse({ ...task, apiKey: "not-a-real-secret" })
      .success,
    false,
  );
  assert.equal(
    delegationTaskSchema.safeParse({ ...task, status: "ack" }).success,
    false,
  );
  assert.equal(
    delegationTaskSchema.safeParse({ ...task, deadlineAt: Infinity }).success,
    false,
  );
  assert.equal(
    delegationTaskSchema.safeParse({ ...task, result: undefined }).success,
    false,
  );
  assert.equal(
    delegationTaskSchema.safeParse({
      ...task,
      items: [{ arbitrary: true }],
      tokenUsage: null,
      approval: { requested: true },
    }).success,
    true,
  );
});

test(
  "Immediate durable ACK, FIFO serial admission, and actual results only after settlement",
  { timeout: 2_000 },
  async (t) => {
    const { coordinator: c, runs, saves } = harness(t, 1);
    const first = c.start(input("first"));
    const second = c.start(input("second"));
    assert.equal(first.status, "queued");
    assert.equal(first.result, "");
    assert.equal(first.createdAt, 1_000);
    assert.equal(first.deadlineAt, 11_000);
    assert.deepEqual(saves[0], [first]);
    assert.equal(runs.length, 0);
    await flush();
    assert.equal(runs.length, 1);
    assert.equal(runs[0].task.id, first.id);
    assert.equal(runs[0].task.task, input().task);
    assert.equal(c.status(second.id, owner), "queued");
    const waiting = c.wait(first.id, owner, 100);
    runs[0].outcome.resolve({ result: "Actual worker result" });
    const completed = await waiting;
    assert.equal(completed.status, "completed");
    assert.equal(completed.result, "Actual worker result");
    assert.equal(runs[0].cleaned, true);
    await flush();
    assert.equal(runs.length, 2);
    assert.equal(runs[1].task.id, second.id);
    assert.equal(saves.at(-1)![0].result, "Actual worker result");
  },
);

test("Default parallel admission occupies exactly two slots until each cleanup settles", async (t) => {
  const { coordinator: c, runs } = harness(t);
  const tasks = ["one", "two", "three", "four"].map((id) =>
    c.start(input(id, { workerId: id })),
  );
  await flush();
  assert.deepEqual(
    runs.map((run) => run.task.id),
    tasks.slice(0, 2).map((task) => task.id),
  );
  runs[1].outcome.resolve({ result: "second completes first" });
  await flush();
  assert.equal(runs.length, 3);
  assert.equal(runs[2].task.id, tasks[2].id);
  assert.equal(c.status(tasks[0].id, owner), "running");
  assert.equal(c.status(tasks[3].id, owner), "queued");
});

test("Concurrency is configurable but requires a positive safe integer", async (t) => {
  for (const queueConcurrency of [
    0,
    -1,
    1.5,
    Infinity,
    NaN,
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.throws(
      () =>
        new DelegationCoordinator({
          load: () => [],
          save: () => {},
          execute: async () => ({ result: "unused" }),
          queueConcurrency,
        }),
      /queueConcurrency/,
    );
  const { coordinator: c, runs } = harness(t, 3);
  for (let i = 0; i < 4; i++)
    c.start(input(String(i), { workerId: String(i) }));
  await flush();
  assert.equal(runs.length, 3);
});

test("Idempotency preserves exact call IDs and rejects every conflicting original field", async (t) => {
  const { coordinator: c, runs, saves } = harness(t);
  const original = input();
  const ack = c.start(original);
  assert.deepEqual(c.start({ ...original }), ack);
  assert.equal(saves.length, 1);
  for (const change of [
    { name: "other" },
    { workerId: "other" },
    { task: "other" },
    { parentConversationId: "other" },
    { parentTurnId: "other" },
    { timeoutMs: 999 },
  ])
    assert.throws(() => c.start({ ...original, ...change }), /Conflicting/);
  await flush();
  assert.equal(c.start(original).status, "running");
  assert.equal(runs[0].task.callId, original.callId);
  runs[0].outcome.resolve({ result: "done" });
  await flush();
  assert.equal(c.start(original).status, "completed");
  assert.equal(runs.length, 1);
  assert.notEqual(
    c.start({ ...original, parentThreadId: "another-thread" }).id,
    ack.id,
  );
  assert.notEqual(
    c.start({ ...original, callId: `${original.callId} ` }).id,
    ack.id,
  );
});

test("The idempotency pair cannot collide through delimiters", (t) => {
  const { coordinator: c } = harness(t);
  const a = c.start(input("b:c", { parentThreadId: "a" }));
  const b = c.start(input("c", { parentThreadId: "a:b" }));
  assert.notEqual(a.id, b.id);
});

test("Invalid budgets fail before persistence or execution", (t) => {
  const { coordinator: c, saves, runs } = harness(t);
  for (const timeoutMs of [0, -1, 0.5, Infinity, NaN, Number.MAX_SAFE_INTEGER])
    assert.throws(() => c.start(input("invalid", { timeoutMs })));
  assert.throws(() => c.start(input("")));
  assert.equal(saves.length, 0);
  assert.equal(runs.length, 0);
});

test("Queued deadline expires without admission; the budget is not reset on running", async (t) => {
  const { coordinator: c, runs } = harness(t, 1);
  const running = c.start(input("blocker"));
  const queued = c.start(input("queue-deadline", { timeoutMs: 50 }));
  const admitted = c.start(input("shared-budget", { timeoutMs: 100 }));
  await flush();
  t.mock.timers.tick(50);
  assert.equal(c.status(queued.id, owner), "failed");
  assert.match(c.get(queued.id, owner).error!, /deadline/);
  assert.equal(runs.length, 1);
  runs[0].outcome.resolve({ result: "release slot" });
  await flush();
  assert.equal(c.status(running.id, owner), "completed");
  assert.equal(runs[1].task.id, admitted.id);
  t.mock.timers.tick(49);
  assert.equal(runs[1].signal.aborted, false);
  t.mock.timers.tick(1);
  assert.equal(runs[1].signal.aborted, true);
  assert.equal(c.status(admitted.id, owner), "running");
  assert.match(c.get(admitted.id, owner).error!, /awaiting executor cleanup/);
  runs[1].outcome.resolve({ result: "late success is not success" });
  await flush();
  assert.equal(c.status(admitted.id, owner), "failed");
  assert.equal(c.get(admitted.id, owner).result, "");
});

test("Admission and late completion check deadlines even before timer callbacks execute", async (t) => {
  const { coordinator: c, runs } = harness(t);
  const queued = c.start(input("already-expired", { timeoutMs: 10 }));
  t.mock.timers.setTime(1_010);
  await flush();
  assert.equal(runs.length, 0);
  assert.equal(c.status(queued.id, owner), "failed");
  const running = c.start(input("late-microtask", { timeoutMs: 10 }));
  await flush();
  t.mock.timers.setTime(1_020);
  runs[0].outcome.resolve({ result: "too late" });
  await flush();
  assert.equal(c.status(running.id, owner), "failed");
});

test("Long deadlines are chunked without native timeout overflow", async (t) => {
  const { coordinator: c, runs } = harness(t);
  c.start(input("long", { timeoutMs: 2_147_483_647 + 100 }));
  await flush();
  t.mock.timers.tick(2_147_483_647);
  assert.equal(runs[0].signal.aborted, false);
  t.mock.timers.tick(100);
  assert.equal(runs[0].signal.aborted, true);
});

test("Cold reconciliation persists unknown once, preserves history/identity, and never replays", async (t) => {
  const loaded = [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "unknown",
  ].map((status) => stored(status as DelegationTask["status"]));
  loaded[1].threadId = "child-thread-exact";
  loaded[1].items = [{ id: "runtime-item" }];
  const original = structuredClone(loaded);
  const { coordinator: c, runs, saves } = harness(t, 2, loaded);
  assert.equal(saves.length, 1);
  assert.deepEqual(
    c.list().map((task) => task.status),
    ["unknown", "unknown", "completed", "failed", "cancelled", "unknown"],
  );
  assert.deepEqual(loaded, original);
  assert.equal(c.get(loaded[1].id, owner).threadId, "child-thread-exact");
  assert.equal(c.get(loaded[1].id, owner).result, loaded[1].result);
  assert.deepEqual(c.list().slice(2), original.slice(2));
  const retry = c.start(input(loaded[0].callId));
  assert.equal(retry.id, loaded[0].id);
  assert.equal(retry.status, "unknown");
  assert.throws(
    () => c.start(input(loaded[0].callId, { task: "conflict" })),
    /Conflicting/,
  );
  await flush();
  assert.equal(runs.length, 0);
  assert.deepEqual(await c.wait(retry.id, owner, 25_000), retry);
  assert.deepEqual(await c.cancel(retry.id, owner), retry);
  let writes = 0;
  const reboot = new DelegationCoordinator({
    load: () => saves[0],
    save: () => {
      writes++;
    },
    execute: async () => {
      assert.fail("cold replay");
    },
  });
  assert.equal(writes, 0);
  await reboot.dispose();
});

test("Duplicate or invalid durable records fail closed before saving or replay", () => {
  const task = stored("queued");
  const options: DelegationCoordinatorOptions = {
    load: () => [],
    save: () => {
      assert.fail("invalid store write");
    },
    execute: async () => {
      assert.fail("invalid replay");
    },
  };
  assert.throws(
    () =>
      new DelegationCoordinator({
        ...options,
        load: () => [task, { ...task, id: "another" }],
      }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      new DelegationCoordinator({
        ...options,
        load: () => [task, { ...task, callId: "another" }],
      }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      new DelegationCoordinator({
        ...options,
        load: () => [{ ...task, deadlineAt: task.createdAt }],
      }),
    /deadline/,
  );
});

test("Cancel awaits cleanup, holds its slot, preserves partial output and rejects late success", async (t) => {
  const { coordinator: c, runs } = harness(t, 1);
  const ack = c.start(input("cancel-me"));
  c.start(input("after-cleanup"));
  await flush();
  runs[0].publish({ result: "real partial output" });
  let settled = false;
  const cancellation = c.cancel(ack.id, owner).then((task) => {
    settled = true;
    return task;
  });
  const repeated = c.cancel(ack.id, owner);
  await flush();
  assert.equal(runs[0].signal.aborted, true);
  assert.equal(settled, false);
  assert.equal(runs[0].cleaned, false);
  assert.equal(runs.length, 1);
  assert.equal(c.status(ack.id, owner), "running");
  runs[0].publish({ result: "ignored after stop", threadId: "ignored" });
  assert.equal(c.get(ack.id, owner).result, "real partial output");
  runs[0].outcome.resolve({ result: "ignored late success" });
  const cancelled = await cancellation;
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.result, "real partial output");
  assert.equal(cancelled.threadId, undefined);
  assert.equal(runs[0].cleaned, true);
  assert.deepEqual(await repeated, cancelled);
  assert.deepEqual(await c.cancel(ack.id, owner), cancelled);
  await flush();
  assert.equal(runs.length, 2);
});

test("Cancel before admission never calls execute", async (t) => {
  const { coordinator: c, runs } = harness(t);
  const ack = c.start(input());
  const cancelled = await c.cancel(ack.id, owner);
  await flush();
  assert.equal(cancelled.status, "cancelled");
  assert.equal(runs.length, 0);
});

test("Executor rejection (including cleanup errors and synchronous throws) is explicit failure", async (t) => {
  const { coordinator: c, runs } = harness(t, 1);
  const failed = c.start(input("fail"));
  await flush();
  runs[0].publish({ result: "preserve partial" });
  runs[0].outcome.reject(new Error("controlled worker failure"));
  await flush();
  assert.equal(c.status(failed.id, owner), "failed");
  assert.match(c.get(failed.id, owner).error!, /controlled worker failure/);
  assert.equal(c.get(failed.id, owner).result, "preserve partial");
  const cancelled = c.start(input("cleanup-error"));
  await flush();
  const cancellation = c.cancel(cancelled.id, owner);
  runs[1].outcome.reject(new Error("controlled cleanup failure"));
  assert.match((await cancellation).error!, /controlled cleanup failure/);
  assert.equal(c.status(cancelled.id, owner), "cancelled");
  const synchronous = new DelegationCoordinator({
    load: () => [],
    save: () => {},
    execute: () => {
      throw new Error("synchronous failure");
    },
  });
  const ack = synchronous.start(input());
  await flush();
  assert.equal(synchronous.status(ack.id, owner), "failed");
  await synchronous.dispose();
});

test("Unauthorized get/status/wait/cancel cannot inspect or affect work; list scopes owners", async (t) => {
  const { coordinator: c, runs } = harness(t);
  const ack = c.start(input());
  const other = c.start(
    input("foreign", { parentConversationId: "foreign-owner" }),
  );
  await flush();
  for (const id of [ack.id, "missing"])
    for (const requester of ["unauthorized", undefined as unknown as string]) {
      assert.throws(() => c.get(id, requester), /not found for this owner/);
      assert.throws(() => c.status(id, requester), /not found for this owner/);
      await assert.rejects(
        c.wait(id, requester, 10),
        /not found for this owner/,
      );
      await assert.rejects(c.cancel(id, requester), /not found for this owner/);
    }
  assert.deepEqual(
    c.list(owner).map((task) => task.id),
    [ack.id],
  );
  assert.deepEqual(
    c.list("foreign-owner").map((task) => task.id),
    [other.id],
  );
  assert.deepEqual(c.list("missing"), []);
  assert.equal(c.list().length, 2);
  assert.equal(
    runs.every((run) => !run.signal.aborted),
    true,
  );
});

test("Owned final cleanup snapshot preserves command evidence after cancel without accepting late success", async (t) => {
  const { coordinator: c, runs } = harness(t);
  const ack = c.start(input());
  await flush();
  runs[0].publish({ items: [{ type: "userMessage" }] });
  const cancelling = c.cancel(ack.id, owner);
  assert.equal(runs[0].signal.aborted, true);
  runs[0].publish({ result: "unmarked late update" });
  assert.equal(c.get(ack.id, owner).result, "");
  const items = [
    {
      id: "original-command-id",
      type: "commandExecution",
      exitCode: 0,
      aggregatedOutput: "actual marker",
    },
  ];
  runs[0].publish(
    {
      items,
      result: "received partial output",
      tokenUsage: { outputTokens: 3 },
    },
    true,
  );
  assert.deepEqual(c.get(ack.id, owner).items, items);
  assert.equal(
    c.get(ack.id, owner).status,
    "running",
    "cleanup still owns the task",
  );
  runs[0].publish({ items: [], result: "duplicate final" }, true);
  runs[0].outcome.resolve({ result: "late executor success" });
  const done = await cancelling;
  assert.equal(done.status, "cancelled");
  assert.equal(done.result, "received partial output");
  assert.deepEqual(done.items, items);
  assert.match(done.error!, /cancelled/);
  runs[0].publish({ items: [], result: "post-settlement" }, true);
  assert.deepEqual(c.get(ack.id, owner), done);
});

test("Published identities/payloads persist verbatim; all snapshots and late updates are isolated", async (t) => {
  const { coordinator: c, runs, saves, changes } = harness(t);
  const ack = c.start(input());
  ack.task = "caller mutation";
  await flush();
  const update = {
    threadId: " thread/工具 ",
    sessionId: "session:opaque",
    turnId: "turn/exact",
    items: [{ id: "item", nested: { value: 1 } }],
    tokenUsage: { output: 3 },
    approval: { id: "approval" },
    result: "partial",
  };
  runs[0].publish(update);
  assert.equal(c.get(ack.id, owner).threadId, update.threadId);
  assert.equal(c.get(ack.id, owner).sessionId, update.sessionId);
  assert.equal(c.get(ack.id, owner).turnId, update.turnId);
  assert.deepEqual(saves.at(-1)![0].items, update.items);
  update.items[0].nested.value = 999;
  runs[0].task.task = "executor mutation";
  changes.at(-1)![0].items = [];
  saves.at(-1)![0].result = "store snapshot mutation";
  const snapshot = c.get(ack.id, owner);
  (snapshot.items![0] as { nested: { value: number } }).nested.value = 888;
  c.list()[0].task = "list mutation";
  assert.deepEqual(c.get(ack.id, owner).items, [
    { id: "item", nested: { value: 1 } },
  ]);
  assert.equal(c.get(ack.id, owner).task, input().task);
  assert.equal(c.get(ack.id, owner).result, "partial");
  runs[0].publish({
    items: [{ id: "replacement" }],
    approval: null,
    result: undefined,
  });
  assert.deepEqual(c.get(ack.id, owner).items, [{ id: "replacement" }]);
  assert.equal(c.get(ack.id, owner).approval, null);
  runs[0].outcome.resolve({ result: "final" });
  await flush();
  const terminal = c.get(ack.id, owner);
  const writes = saves.length;
  runs[0].publish({
    result: "late",
    tokenUsage: { output: 999 },
    threadId: "wrong",
  });
  assert.deepEqual(c.get(ack.id, owner), terminal);
  assert.equal(saves.length, writes);
});

test("Malformed published data fails the task, aborts, and never persists extra fields", async (t) => {
  const { coordinator: c, runs, saves } = harness(t);
  const ack = c.start(input());
  await flush();
  runs[0].publish({
    result: "partial",
    credentials: "not-a-real-secret",
  } as Parameters<DelegationPublish>[0]);
  assert.equal(runs[0].signal.aborted, true);
  runs[0].outcome.resolve({ result: "must not succeed" });
  await flush();
  assert.equal(c.status(ack.id, owner), "failed");
  assert.match(c.get(ack.id, owner).error!, /Invalid delegation update/);
  assert.equal(
    saves.every((tasks) => tasks.every((task) => !("credentials" in task))),
    true,
  );
});

test("wait returns terminal or bounded current state, without cancelling or polling", async (t) => {
  const { coordinator: c, runs } = harness(t);
  const ack = c.start(input());
  assert.deepEqual(await c.wait(ack.id, owner, 0), ack);
  await flush();
  let resolved = false;
  const waiting = c.wait(ack.id, owner, 25).then((task) => {
    resolved = true;
    return task;
  });
  runs[0].publish({ result: "progress is not terminal" });
  await flush();
  assert.equal(resolved, false);
  t.mock.timers.tick(25);
  const current = await waiting;
  assert.equal(current.status, "running");
  assert.equal(current.result, "progress is not terminal");
  assert.equal(runs[0].signal.aborted, false);
  const first = c.wait(ack.id, owner, 25_000);
  const second = c.wait(ack.id, owner, 25_000);
  runs[0].outcome.resolve({ result: "settled result" });
  assert.equal((await first).status, "completed");
  assert.deepEqual(await second, await c.wait(ack.id, owner, 25_000));
  for (const ms of [-1, 0.5, 25_001, Infinity, NaN])
    await assert.rejects(c.wait(ack.id, owner, ms), /0 through 25000/);
});

test("wait abort rejects only that waiter and accepts already-aborted signals", async (t) => {
  const { coordinator: c, runs } = harness(t);
  const ack = c.start(input());
  await flush();
  const controller = new AbortController();
  const waiting = c.wait(ack.id, owner, 25_000, controller.signal);
  const rejection = assert.rejects(waiting, /caller stopped waiting/);
  controller.abort(new Error("caller stopped waiting"));
  await rejection;
  await assert.rejects(
    c.wait(ack.id, owner, 25_000, controller.signal),
    /caller stopped waiting/,
  );
  assert.equal(runs[0].signal.aborted, false);
  assert.equal(c.status(ack.id, owner), "running");
  runs[0].outcome.resolve({ result: "worker continues" });
  await flush();
  t.mock.timers.tick(25_000);
  assert.equal(c.status(ack.id, owner), "completed");
});

test("Dispose aborts all owned work, awaits every cleanup, and prevents new admission", async (t) => {
  const { coordinator: c, runs, saves } = harness(t);
  const tasks = ["one", "two", "queued"].map((id) =>
    c.start(input(id, { workerId: id })),
  );
  await flush();
  let disposed = false;
  const disposal = c.dispose();
  assert.equal(c.dispose(), disposal);
  const observed = disposal.then(() => {
    disposed = true;
  });
  assert.equal(
    runs.every((run) => run.signal.aborted),
    true,
  );
  assert.equal(c.status(tasks[2].id, owner), "cancelled");
  assert.throws(() => c.start(input("no-new-work")), /disposed/);
  await flush();
  assert.equal(disposed, false);
  runs[0].outcome.reject(new Error("abort cleanup settled"));
  await flush();
  assert.equal(disposed, false);
  runs[1].outcome.resolve({ result: "late" });
  await observed;
  assert.equal(
    runs.every((run) => run.cleaned),
    true,
  );
  assert.equal(runs.length, 2);
  assert.deepEqual(
    c.list().map((task) => task.status),
    ["cancelled", "cancelled", "cancelled"],
  );
  const writes = saves.length;
  t.mock.timers.tick(100_000);
  for (const run of runs) run.publish({ result: "late after disposal" });
  assert.equal(saves.length, writes);
});

test("Dispose before the admission microtask cancels queued ACKs without execution", async (t) => {
  const { coordinator: c, runs } = harness(t);
  const ack = c.start(input());
  await c.dispose();
  await flush();
  assert.equal(runs.length, 0);
  assert.equal(c.status(ack.id, owner), "cancelled");
});

test("A failed ACK save throws and permits a clean retry without phantom work", async () => {
  let fail = true;
  let calls = 0;
  const c = new DelegationCoordinator({
    load: () => [],
    save: () => {
      if (fail) throw new Error("controlled storage failure");
    },
    execute: async () => {
      calls++;
      return { result: "actual result" };
    },
  });
  assert.throws(() => c.start(input()), /controlled storage failure/);
  assert.equal(c.list().length, 0);
  fail = false;
  const ack = c.start(input());
  await flush();
  assert.equal(c.status(ack.id, owner), "completed");
  assert.equal(calls, 1);
  await c.dispose();
});

test("Background persistence failure is explicit unknown, stops admission, and is reported by dispose", async () => {
  const outcome = deferred<{ result: string }>();
  let durableTasks: DelegationTask[] = [];
  let fail = false;
  let signal!: AbortSignal;
  const c = new DelegationCoordinator({
    load: () => [],
    save: (tasks) => {
      if (fail) throw new Error("controlled disk failure");
      durableTasks = tasks;
    },
    execute: async (_task, abort) => {
      signal = abort;
      return await outcome.promise;
    },
  });
  const ack = c.start(input());
  await flush();
  fail = true;
  const cancellation = c.cancel(ack.id, owner);
  const cancellationFailure = assert.rejects(cancellation, /lifecycle failed/);
  assert.equal(signal.aborted, true);
  outcome.resolve({ result: "not durable success" });
  await cancellationFailure;
  assert.equal(c.status(ack.id, owner), "unknown");
  assert.equal(durableTasks[0].status, "running");
  assert.ok(c.failure instanceof AggregateError);
  assert.throws(() => c.start(input("blocked")), /lifecycle failed/);
  await assert.rejects(c.dispose(), /lifecycle failed/);
});

test("Observer exceptions are collected, abort owned work, and reject disposal without leaking promises", async () => {
  const outcome = deferred<{ result: string }>();
  let publish!: DelegationPublish;
  let signal!: AbortSignal;
  let fail = false;
  const c = new DelegationCoordinator({
    load: () => [],
    save: () => {},
    onChange: () => {
      if (fail) throw new Error("controlled observer failure");
    },
    execute: async (_task, abort, update) => {
      signal = abort;
      publish = update;
      return await outcome.promise;
    },
  });
  const ack = c.start(input());
  await flush();
  fail = true;
  publish({ result: "partial" });
  assert.equal(signal.aborted, true);
  outcome.resolve({ result: "not success" });
  await flush();
  assert.equal(c.status(ack.id, owner), "failed");
  assert.ok(
    c.failure?.errors.some((error: Error) => /onChange/.test(error.message)),
  );
  await assert.rejects(c.dispose(), /lifecycle failed/);
});

test("Default resource key serializes the same conversation/worker while admitting another worker", async (t) => {
  const { coordinator: c, runs } = harness(t);
  const first = c.start(input("same-worker-first"));
  const blocked = c.start(input("same-worker-second"));
  const other = c.start(
    input("other-worker", { workerId: "independent-worker" }),
  );
  await flush();
  assert.deepEqual(
    runs.map((run) => run.task.id),
    [first.id, other.id],
  );
  assert.equal(c.status(blocked.id, owner), "queued");
  runs[0].outcome.resolve({ result: "released" });
  await flush();
  assert.equal(runs[2].task.id, blocked.id);
});

test("Canonical ancestor workspaces serialize across conversations, not merely matching IDs", async (t) => {
  const paths = {
    parent: resolve("/owned/project"),
    child: resolve("/owned/project/subdir"),
    sibling: resolve("/owned/project-other"),
  };
  assert.equal(workspaceOverlap(paths.parent, paths.child), true);
  assert.equal(workspaceOverlap(paths.child, paths.parent), true);
  assert.equal(workspaceOverlap(paths.parent, paths.sibling), false);
  const { coordinator: c, runs } = harness(
    t,
    3,
    [],
    (task) => paths[task.workerId as keyof typeof paths],
    workspaceOverlap,
  );
  const first = c.start(input("parent", { workerId: "parent" }));
  const blocked = c.start(
    input("nested", { workerId: "child", parentConversationId: "other-owner" }),
  );
  const other = c.start(input("sibling", { workerId: "sibling" }));
  await flush();
  assert.deepEqual(
    runs.map((r) => r.task.id),
    [first.id, other.id],
  );
  assert.equal(c.status(blocked.id, "other-owner"), "queued");
  runs[0].outcome.resolve({ result: "release parent" });
  await flush();
  assert.equal(runs[2].task.id, blocked.id);
});

test("Custom shared resource serializes across owners, skips blocked work, and holds through cleanup", async (t) => {
  const { coordinator: c, runs } = harness(t, 3, [], (task) =>
    task.workerId === "independent-worker" ? "workspace-B" : "workspace-A",
  );
  const first = c.start(input("first"));
  const blocked = c.start(
    input("blocked", {
      parentConversationId: "another-owner",
      workerId: "another-worker",
    }),
  );
  const other = c.start(input("other", { workerId: "independent-worker" }));
  await flush();
  assert.deepEqual(
    runs.map((run) => run.task.id),
    [first.id, other.id],
  );
  const cancellation = c.cancel(first.id, owner);
  await flush();
  assert.equal(runs[0].signal.aborted, true);
  assert.equal(runs[0].cleaned, false);
  assert.equal(c.status(blocked.id, "another-owner"), "queued");
  runs[1].outcome.resolve({ result: "other resource finished" });
  await flush();
  assert.equal(runs.length, 2);
  runs[0].outcome.resolve({ result: "late success after cleanup" });
  assert.equal((await cancellation).status, "cancelled");
  await flush();
  assert.equal(runs[0].cleaned, true);
  assert.equal(runs[2].task.id, blocked.id);
});

test("Resource key validation fails before ACK and receives an isolated task snapshot", async () => {
  let key = "";
  let writes = 0;
  const c = new DelegationCoordinator({
    load: () => [],
    save: () => {
      writes++;
    },
    resourceKey: (task) => {
      task.task = "callback mutation";
      return key;
    },
    execute: async () => ({ result: "actual result" }),
  });
  assert.throws(() => c.start(input()), /resourceKey/);
  assert.equal(writes, 0);
  assert.deepEqual(c.list(), []);
  key = "workspace";
  const ack = c.start(input());
  assert.equal(ack.task, input().task);
  await flush();
  assert.equal(c.status(ack.id, owner), "completed");
  await c.dispose();
});

test("An unpersisted executor success becomes unknown and wakes local waiters explicitly", async () => {
  const outcome = deferred<{ result: string }>();
  let fail = false;
  const c = new DelegationCoordinator({
    load: () => [],
    save: () => {
      if (fail) throw new Error("controlled terminal write failure");
    },
    execute: async () => outcome.promise,
  });
  const ack = c.start(input());
  await flush();
  const waiting = c.wait(ack.id, owner, 100);
  fail = true;
  outcome.resolve({ result: "real but not durably committed" });
  const task = await waiting;
  assert.equal(task.status, "unknown");
  assert.equal(task.result, "real but not durably committed");
  assert.match(task.error!, /persistence failed/);
  await assert.rejects(c.dispose(), /lifecycle failed/);
});

test("Missing executor result is failed, never a successful ACK or published partial", async () => {
  const c = new DelegationCoordinator({
    load: () => [],
    save: () => {},
    execute: async (_task, _signal, publish) => {
      publish({ result: "partial is not completion" });
      return {} as { result: string };
    },
  });
  const ack = c.start(input());
  await flush();
  assert.equal(c.status(ack.id, owner), "failed");
  assert.equal(c.get(ack.id, owner).result, "partial is not completion");
  assert.match(c.get(ack.id, owner).error!, /string result/);
  await c.dispose();
});
