import test from "node:test";
import assert from "node:assert/strict";
import { delegationTools } from "../src/engine/delegation-tools";
import type {
  DelegationCoordinator,
  DelegationTask,
} from "../src/engine/delegation-coordinator";
import type { WorkerDefinition } from "../src/shared/orchestration";
import type { DynamicToolCallParams } from "../src/protocol/codex-0.153.4/v2/DynamicToolCallParams";

const worker: WorkerDefinition = {
  id: "exact_worker",
  name: "Configured worker",
  selection: {
    providerId: "Exact/Provider",
    model: "Exact/Model",
    effort: "Provider-Effort",
    context: 262144,
  },
  workspaceId: "private-workspace",
  timeoutMs: 1000,
  contractHash: "a".repeat(64),
};
const params = (
  tool: string,
  args: DynamicToolCallParams["arguments"],
): DynamicToolCallParams => ({
  threadId: "parent/thread",
  turnId: "parent/turn",
  callId: "original/call",
  namespace: null,
  tool,
  arguments: args,
});
const signal = new AbortController().signal;
function value(
  result: Awaited<ReturnType<ReturnType<typeof delegationTools>["call"]>>,
) {
  assert.equal(result.success, true);
  const item = result.contentItems[0];
  assert.equal(item.type, "inputText");
  if (item.type !== "inputText") throw Error("Expected text result");
  return JSON.parse(item.text);
}

test("Supervisor inventory preserves exact selections and excludes host-only configuration", async () => {
  const tools = delegationTools("owner", [worker], {} as DelegationCoordinator);
  assert.deepEqual(
    value(await tools.call(params("synora_workers", {}), signal)),
    [{ id: worker.id, name: worker.name, ...worker.selection }],
  );
  assert.deepEqual(
    tools.catalog.map((t) => t.name),
    [
      "synora_workers",
      "synora_delegate",
      "synora_review",
      "synora_wait",
      "synora_cancel",
    ],
  );
});

test("Worker report distinguishes pending approvals/questions from terminal results without changing identities", async () => {
  // Controlled boundary test, not a real worker/Core lifecycle qualification.
  for (const status of [
    "queued",
    "running",
    "completed",
    "failed",
    "cancelled",
    "unknown",
  ] as const) {
    for (const pending of [false, true]) {
      const task: DelegationTask = {
        id: "ee9d667e-c1a2-4c5a-8d3b-a8be788ae370",
        name: "Exact task",
        workerId: worker.id,
        parentConversationId: "owner",
        parentThreadId: "parent/thread",
        parentTurnId: "parent/turn",
        callId: "original/call",
        task: "Read-only fixture",
        status,
        createdAt: 1,
        updatedAt: 2,
        deadlineAt: 3,
        result: "exact result",
        threadId: "worker/thread",
        sessionId: "worker/session",
        turnId: "worker/turn",
        approval: {
          approval: pending ? { id: "original/approval" } : null,
          questions: pending ? [{ id: "original/question" }] : [],
        },
      };
      const stub = {
        wait: async (
          id: string,
          owner: string,
          timeout: number,
          received: AbortSignal,
        ) => {
          assert.equal(id, task.id);
          assert.equal(owner, "owner");
          assert.equal(timeout, 25000);
          assert.equal(received, signal);
          return task;
        },
      } as unknown as DelegationCoordinator;
      const report = value(
        await delegationTools("owner", [worker], stub).call(
          params("synora_wait", { task_id: task.id }),
          signal,
        ),
      );
      assert.equal(report.status, status);
      assert.equal(report.needs_approval, status === "running" && pending);
      assert.equal(report.needs_user_input, status === "running" && pending);
      assert.equal(report.thread_id, task.threadId);
      assert.equal(report.session_id, task.sessionId);
      assert.equal(report.turn_id, task.turnId);
      assert.equal(report.result, task.result);
      assert.equal("approval" in report, false);
    }
  }
});

test("Supervisor boundary rejects invented workers/tools and invalid or aborted calls before dispatch", async () => {
  const tools = delegationTools("owner", [worker], {} as DelegationCoordinator);
  await assert.rejects(
    tools.call(
      params("synora_delegate", {
        worker_id: "Luna",
        name: "task",
        task: "task",
      }),
      signal,
    ),
    /not configured/,
  );
  await assert.rejects(
    tools.call(params("synora_wait", { task_id: "invalid" }), signal),
  );
  await assert.rejects(
    tools.call(
      params("invented_tool", {
        task_id: "ee9d667e-c1a2-4c5a-8d3b-a8be788ae370",
      }),
      signal,
    ),
    /Unknown supervisor tool/,
  );
  await assert.rejects(
    tools.call(params("synora_workers", { model: "override" }), signal),
  );
  await assert.rejects(
    tools.call(
      params("synora_workers", {}),
      AbortSignal.abort(new Error("owned cancellation")),
    ),
    /owned cancellation/,
  );
});
