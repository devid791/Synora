// Explicit protocol fixture. Never presented as model or production evidence.
import readline from "node:readline";
import { appendFileSync, readFileSync } from "node:fs";
import { coreModel } from "./core-model.mjs";
import assert from "node:assert/strict";
const { thread: base, command } = JSON.parse(
  readFileSync(new URL("./live-base.json", import.meta.url), "utf8"),
);
const scenario = process.argv[2] ?? "text";
if (scenario === "openai-wait")
  process.on("SIGTERM", () => setTimeout(() => process.exit(0), 150));
const input = readline.createInterface({ input: process.stdin });
const send = (v) => process.stdout.write(JSON.stringify(v) + "\n");
const reply = (m, result) => send({ id: m.id, result });
const note = (method, params) => send({ method, params });
const threadId = scenario === "provider-restore" ? `${process.argv[3]}-thread` : base.id;
let turnId = "fixture-turn",
  compactTimer;
const turn = (status, items = []) => ({
  id: turnId,
  status,
  items,
  itemsView: "summary",
  error: null,
  startedAt: 1,
  completedAt: status === "inProgress" ? null : 2,
  durationMs: status === "inProgress" ? null : 1000,
});
const user = {
  type: "userMessage",
  id: "fixture-user",
  clientId: null,
  content: [{ type: "text", text: "fixture prompt", text_elements: [] }],
};
const assistant = (text) => ({
  type: "agentMessage",
  id: "fixture-assistant",
  text,
  phase: null,
  memoryCitation: null,
  delivery: null,
  questions: null,
});
const item = (v, done = false) =>
  note(done ? "item/completed" : "item/started", {
    threadId,
    turnId,
    item: v,
    ...(done ? { completedAtMs: 2 } : { startedAtMs: 1 }),
  });
const finish = (status = "completed", text = "FIXTURE_OK") => {
  const a = assistant("");
  item(a);
  note("item/agentMessage/delta", {
    threadId,
    turnId,
    itemId: a.id,
    delta: text,
  });
  item(assistant(text), true);
  note("turn/completed", { threadId, turn: turn(status, [assistant(text)]) });
};
const answers = [];
let childDone = false,
  readCount = 0;
let catalogReads = 0;
let usageTurnCount = 0;
let cancellationCommandLive = false;
const childId = "fixture-child",
  childTurn = "fixture-child-turn";
const subagent = (kind) => ({ type: "subAgentActivity", id: `subagent-${kind}`,
  kind, agentThreadId: childId, agentPath: "/root/fixture-reader" });
const collab = (tool, status = "completed") => ({
  type: "collabAgentToolCall",
  id: `call-${tool}`,
  tool,
  status,
  senderThreadId: threadId,
  receiverThreadIds: [childId],
  prompt: tool === "spawnAgent" ? "Read the owned fixture" : null,
  agentsStates: {
    [childId]: {
      status: childDone ? "completed" : "pendingInit",
      message: childDone ? "CHILD_RESULT" : null,
    },
  },
});
const childMessage = { ...assistant("CHILD_RESULT"), id: "child-message" };
const childCommand = {
  ...command,
  id: "child-command",
  aggregatedOutput: "CHILD_RESULT\n",
};
const childTurnRecord = () => ({
  ...turn(
    childDone ? "completed" : "inProgress",
    childDone ? [childCommand, childMessage] : [],
  ),
  id: childTurn,
});
input.on("line", (line) => {
  const m = JSON.parse(line);
  if (process.env.SYNORA_FIXTURE_RPC_LOG && m.method)
    appendFileSync(
      process.env.SYNORA_FIXTURE_RPC_LOG,
      JSON.stringify({ pid: process.pid, method: m.method, params: m.params }) +
        "\n",
    );
  if ("result" in m || "error" in m) {
    if (scenario.startsWith("host-tool")) {
      assert.equal(m.id, "host-rpc-id");
      return finish("completed", JSON.stringify(m));
    }
    if (scenario === "user-input") {
      answers.push({ id: m.id, idType: typeof m.id, result: m.result });
      if (answers.length === 2) finish("completed", JSON.stringify(answers));
      return;
    }
    answers.push({ type: typeof m.id, id: m.id, decision: m.result?.decision });
    if (answers.length === 2) finish("completed", JSON.stringify(answers));
    return;
  }
  if (m.method === "initialize")
    return reply(m, { userAgent: "Synora protocol fixture" });
  if (m.method === "initialized") return;
  if (m.method === "thread/loaded/list")
    return reply(m, { data: [], nextCursor: null });
  if (m.method === "account/read")
    return reply(m, { account: { type: "apiKey" }, requiresOpenaiAuth: true });
  if (m.method === "model/list") {
    catalogReads++;
    return reply(m, {
      data:
        scenario === "openai-catalog-removed" && catalogReads > 1
          ? []
          : [coreModel],
      nextCursor: null,
    });
  }
  if (m.method === "thread/read") {
    readCount++;
    if (scenario === "agents-read-error" || scenario === "subagents-read-error")
      return send({
        id: m.id,
        error: { code: -32000, message: "Fixture metadata unavailable" },
      });
    const result = {
      thread: {
        ...base,
        id: childId,
        sessionId: "core-child-session",
        parentThreadId:
          scenario === "agents-wrong-parent" || scenario === "subagents-wrong-parent" ? "alien-parent" : threadId,
        agentNickname: "Darwin",
        turns: [childTurnRecord()],
      },
    };
    return setTimeout(() => reply(m, result), readCount === 1 ? 65 : 1);
  }
  if (m.method === "windowsSandbox/readiness")
    return reply(m, { status: "ready" });
  if (m.method === "mcpServerStatus/list")
    return reply(m, {
      data: [
        {
          name: scenario === "plugin-only" ? "proof" : "synora_test_web",
          runtimeStatus: scenario === "mcp-failed" ? "failed" : "connected",
          pluginId: scenario === "plugin-only" ? "proof@personal" : null,
          serverInfo: null,
          authStatus: "unsupported",
          resources: [],
          resourceTemplates: [],
          tools: Object.fromEntries(
            [
              "web_search",
              ...(scenario === "mcp-missing" ? [] : ["web_fetch"]),
            ].map((name) => [name, { name, inputSchema: { type: "object" } }]),
          ),
        },
      ],
      nextCursor: scenario === "mcp-cursor" ? "repeat" : null,
    });
  if (m.method === "thread/start" || m.method === "thread/resume") {
    if (scenario.startsWith("subagents") && m.method === "thread/resume") childDone = true;
    if (
      scenario.startsWith("host-tool") &&
      scenario !== "host-tool-unmounted"
    ) {
      if (m.method === "thread/start")
        assert.equal(m.params.dynamicTools[0].name, "synora_delegate");
      else
        assert.ok(
          !m.params.dynamicTools,
          "Core resumes its original stored catalog",
        );
    }
    if (scenario.startsWith("openai")) {
      assert.equal(m.params.modelProvider, "openai");
      assert.equal(m.params.model, coreModel.model);
      assert.equal(m.params.config.model_reasoning_effort, "high");
      assert.ok(!("model_context_window" in m.params.config));
    }
    const result = {
      thread: {
        ...base,
        id: scenario === "wrong-identity" ? "different-thread" : threadId,
      },
      model: "qwen3.8-27b-nvfp4",
      modelProvider: "synora_axiom",
      cwd: "/synora-fixture",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandbox:
        scenario === "permission-downgrade"
          ? { type: "readOnly", networkAccess: false }
          : {
              type: "workspaceWrite",
              writableRoots: [],
              networkAccess: false,
              excludeTmpdirEnvVar: false,
              excludeSlashTmp: false,
            },
    };
    if (scenario === "provider-restore") {
      const openai = process.argv[3] === "openai";
      assert.equal(m.params.modelProvider, openai ? "openai" : "synora_axiom");
      assert.equal(m.params.model, openai ? coreModel.model : "qwen3.8-27b-nvfp4");
      assert.equal(m.method, "thread/resume", "This fixture only qualifies restoration, never a new thread");
      assert.equal(m.params.threadId, threadId);
      result.thread = { ...base, id: threadId, sessionId: `${process.argv[3]}-session`,
        modelProvider: m.params.modelProvider, model: m.params.model, cwd: m.params.cwd };
      result.model = m.params.model;
      result.modelProvider = m.params.modelProvider;
      result.cwd = m.params.cwd;
    }
    if (scenario === "permissions-full") {
      assert.equal(m.params.approvalPolicy, "never");
      assert.equal(m.params.approvalsReviewer, "user");
      assert.equal(m.params.sandbox, "danger-full-access");
      result.approvalPolicy = "never";
      result.sandbox = { type: "dangerFullAccess" };
    }
    if (scenario === "permissions-auto") {
      assert.equal(m.params.approvalPolicy, "on-request");
      assert.equal(m.params.approvalsReviewer, "auto_review");
      assert.equal(m.params.sandbox, "workspace-write");
      result.approvalsReviewer = "auto_review";
    }
    if (scenario === "permissions-change" || scenario === "permissions-change-rejected") {
      if (m.method === "thread/resume") assert.equal(m.params.threadId, threadId);
      const policies = {
        ask: ["on-request", "user", "workspace-write"],
        full: ["never", "user", "danger-full-access"],
        "auto-review": ["on-request", "auto_review", "workspace-write"],
      };
      // Process's startup policy must match the request; reusing an old
      // transport for a different selection is an explicit regression.
      assert.deepEqual([m.params.approvalPolicy, m.params.approvalsReviewer, m.params.sandbox], policies[process.argv[3]]);
      result.approvalPolicy = m.params.approvalPolicy;
      result.approvalsReviewer = m.params.approvalsReviewer;
      if (m.params.sandbox === "danger-full-access" && scenario !== "permissions-change-rejected") result.sandbox = { type: "dangerFullAccess" };
    }
    return reply(m, result);
  }
  if (m.method === "thread/items/list") {
    const first = !m.params.cursor;
    return reply(m, {
      data: [{ turnId, item: scenario.startsWith("subagents")
        ? subagent(first ? "started" : "completed") : first ? user : command }],
      nextCursor: scenario === "repeated-cursor" || first ? "page-two" : null,
      backwardsCursor: null,
    });
  }
  if (m.method === "thread/turns/list")
    return reply(m, {
      data: scenario === "restore-empty" ? [] : [
        { ...turn(["persistent-wait", "restore-incomplete"].includes(scenario) ? "inProgress" : "completed", [
          user,
          command,
          assistant("FIXTURE_OK"),
        ]), ...(scenario === "restore-missing-times" ? { startedAt: null, completedAt: null, durationMs: null }
          : scenario === "restore-precise-times" ? { startedAt: 100, completedAt: 108, durationMs: 8356 } : {}) },
      ],
      nextCursor: null,
      backwardsCursor: null,
    });
  if (m.method === "thread/compact/start") {
    assert.equal(m.params.threadId, threadId);
    if (scenario === "compact-invalid") return reply(m, "not-an-object");
    reply(m, {});
    if (scenario === "compact-no-start") return;
    turnId = "compact-turn";
    note("turn/started", { threadId, turn: turn("inProgress") });
    const compact = { type: "contextCompaction", id: "compact-item" };
    item(compact);
    // Same thread, prior turn: must not corrupt the current operation.
    note("item/agentMessage/delta", {
      threadId,
      turnId: "fixture-turn",
      itemId: "fixture-assistant",
      delta: "STALE",
    });
    note("turn/completed", {
      threadId,
      turn: { ...turn("completed"), id: "fixture-turn" },
    });
    if (scenario === "compact-wait") return;
    if (scenario === "compact-impossible-terminal") {
      note("turn/completed", { threadId, turn: turn("inProgress", [compact]) });
      return;
    }
    compactTimer = setTimeout(() => {
      const failed = scenario === "compact-failed";
      if (!failed && scenario !== "compact-missing-item-end")
        item(compact, true);
      note("turn/completed", {
        threadId,
        turn: {
          ...turn(failed ? "failed" : "completed", [compact]),
          error: failed
            ? {
                message: "Controlled compaction failure",
                codexErrorInfo: null,
                additionalDetails: null,
              }
            : null,
        },
      });
    }, 80);
    return;
  }
  if (m.method === "turn/interrupt" && scenario.startsWith("compact")) {
    clearTimeout(compactTimer);
    reply(m, {});
    note("turn/completed", {
      threadId,
      turn: turn("interrupted", [
        { type: "contextCompaction", id: "compact-item" },
      ]),
    });
    return;
  }
  if (m.method === "turn/start") {
    if (scenario.startsWith("busy-")) {
      turnId = `busy-turn-${process.pid}-${++usageTurnCount}`;
      user.id = `busy-user-${process.pid}-${usageTurnCount}`;
      user.content = m.params.input.map(v => v.type === "text" ? { ...v, text_elements: v.text_elements ?? [] } : v);
    }
    if (scenario === "usage") turnId = `usage-turn-${++usageTurnCount}`;
    if (scenario === "images") {
      assert.deepEqual(m.params.input, [
        { type: "localImage", path: "/synora-fixture/owned.png" },
      ]);
      user.content = m.params.input;
    }
    if (scenario.startsWith("openai")) {
      assert.equal(m.params.effort, "high");
      assert.equal(m.params.collaborationMode.settings.model, coreModel.model);
      assert.equal(
        m.params.collaborationMode.settings.reasoning_effort,
        "high",
      );
    }
    reply(m, { turn: turn("inProgress") });
    note("turn/started", { threadId, turn: turn("inProgress") });
    item(user, true);
    if (scenario.startsWith("busy-")) {
      if (scenario === "busy-queue") compactTimer = setTimeout(() => finish(), 120);
      return;
    }
    if (scenario === "usage") {
      const breakdown = (n) => ({ totalTokens: n, inputTokens: n - 5,
        outputTokens: 5, reasoningOutputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0 });
      const usage = { total: { ...breakdown(usageTurnCount * 100), outputTokens: usageTurnCount * 5,
        inputTokens: usageTurnCount * 95 }, last: breakdown(100), modelContextWindow: 262144 };
      const params = { threadId, turnId, tokenUsage: usage };
      setTimeout(() => {
        note("thread/tokenUsage/updated", params);
        note("thread/tokenUsage/updated", params); // duplicate must not be summed
        note("thread/tokenUsage/updated", { ...params, threadId: "foreign" });
        finish();
      }, 30);
      return;
    }
    if (scenario.startsWith("host-tool")) {
      send({
        id: "host-rpc-id",
        method: "item/tool/call",
        params: {
          threadId: scenario === "host-tool-foreign" ? "foreign" : threadId,
          turnId,
          callId: "host-original-call-id",
          namespace: null,
          tool: "synora_delegate",
          arguments: { worker_id: "worker_one", task: "owned task" },
        },
      });
      return;
    }
    if (scenario === "compact-auto") {
      const compact = {
        type: "contextCompaction",
        id: "automatic-compact-item",
      };
      item(compact);
      setTimeout(() => {
        item(compact, true);
        finish();
      }, 60);
      return;
    }
    if (scenario.startsWith("agents")) {
      setTimeout(() => item(collab("spawnAgent"), true), 15);
      setTimeout(() => {
        note("turn/started", { threadId: childId, turn: childTurnRecord() });
        note("item/started", {
          threadId: childId,
          turnId: childTurn,
          item: { ...childMessage, text: "" },
          startedAtMs: 1,
        });
        note("item/agentMessage/delta", {
          threadId: childId,
          turnId: childTurn,
          itemId: childMessage.id,
          delta: "CHILD_",
        });
      }, 25);
      setTimeout(() => {
        childDone = true;
        note("item/completed", {
          threadId: childId,
          turnId: childTurn,
          item: childCommand,
          completedAtMs: 2,
        });
        note("item/completed", {
          threadId: childId,
          turnId: childTurn,
          item: childMessage,
          completedAtMs: 2,
        });
        note("turn/completed", { threadId: childId, turn: childTurnRecord() });
        item(collab("wait"), true);
        item(collab("closeAgent"), true);
        finish("completed", "PARENT_DONE");
      }, 45);
      return;
    }
    if (scenario.startsWith("subagents")) {
      // Current Core receipt shape: no child thread/started notification, no
      // collab spawn result and an empty wait receiver list. Read-only history
      // must supply the original child work, including a delayed first read.
      setTimeout(() => item(subagent("started"), true), 15);
      setTimeout(() => {
        childDone = true;
        item({ ...collab("wait"), receiverThreadIds: [], agentsStates: {} }, true);
        item(subagent("completed"), true);
        finish("completed", "PARENT_DONE");
      }, 45);
      return;
    }
    if (scenario === "malformed")
      return note("item/agentMessage/delta", {
        threadId,
        turnId,
        itemId: "missing",
        delta: "invalid",
      });
    if (scenario === "cancel-command") {
      cancellationCommandLive = true;
      item({
        ...command,
        status: "inProgress",
        processId: "owned-core-command",
      });
      return;
    }
    if (
      scenario === "wait" ||
      scenario === "openai-wait" ||
      scenario === "persistent-wait"
    )
      return;
    if (scenario === "user-input" || scenario === "resolved-input") {
      send({
        id: 7,
        method: "item/tool/requestUserInput",
        params: {
          threadId,
          turnId,
          itemId: "question-item",
          questions: [
            {
              id: "choice",
              header: "Choice",
              question: "Choose a fixture option",
              isOther: false,
              isSecret: false,
              options: [
                { label: "A", description: "First" },
                { label: "B", description: "Second" },
              ],
            },
            {
              id: "private",
              header: "Private",
              question: "Fixture-only private answer",
              isOther: true,
              isSecret: true,
              options: null,
            },
          ],
          isBlocking: true,
          autoResolutionMs: null,
        },
      });
      if (scenario === "resolved-input") {
        setTimeout(
          () => note("serverRequest/resolved", { threadId, requestId: 7 }),
          100,
        );
        setTimeout(() => finish(), 150);
      } else
        send({
          id: "7",
          method: "item/permissions/requestApproval",
          params: {
            threadId,
            turnId,
            itemId: "permission-item",
            environmentId: null,
            startedAtMs: 1,
            cwd: "/synora-fixture",
            reason: "Controlled fixture, never executed",
            permissions: { network: { enabled: true }, fileSystem: null },
          },
        });
      return;
    }
    if (scenario === "approvals" || scenario === "approvals-delayed") {
      for (const id of [7, "7"])
        (scenario === "approvals-delayed" && typeof id === "string"
          ? (value) => setTimeout(() => send(value), 40)
          : send)({
          id,
          method: "item/commandExecution/requestApproval",
          params: {
            kind: "command",
            threadId,
            turnId,
            itemId: `item-${typeof id}`,
            startedAtMs: 1,
            environmentId: null,
            command: "fixture-only",
            cwd: null,
            reason: "Controlled protocol approval; never executed",
          },
        });
      return;
    }
    item(command);
    item(command, true);
    return setTimeout(() => finish(), 20);
  }
  if (m.method === "turn/steer" && scenario.startsWith("busy-")) {
    assert.equal(m.params.threadId, threadId);
    assert.equal(m.params.expectedTurnId, turnId);
    assert.equal(typeof m.params.clientUserMessageId, "string");
    if (scenario === "busy-reject") return send({ id: m.id, error: { code: -32600, message: "No matching active turn" } });
    if (scenario === "busy-wrong-id") return reply(m, { turnId: "foreign-turn" });
    const steered = { ...user, id: m.params.clientUserMessageId, clientId: m.params.clientUserMessageId, content: m.params.input };
    item(steered, true);
    if (scenario === "busy-late") return setTimeout(() => reply(m, { turnId }), 100);
    reply(m, { turnId });
    return;
  }
  if (m.method === "turn/interrupt") {
    if (scenario.startsWith("busy-")) clearTimeout(compactTimer);
    reply(m, {});
    note("turn/completed", { threadId, turn: turn("interrupted", [user]) });
    return;
  }
  if (m.method === "thread/backgroundTerminals/list")
    return reply(m, {
      data: cancellationCommandLive
        ? [
            {
              itemId: command.id,
              processId: "owned-core-command",
              command: "fixture only",
              cwd: "/synora-fixture",
            },
          ]
        : [],
      nextCursor: null,
    });
  if (m.method === "thread/backgroundTerminals/terminate") {
    assert.equal(m.params.threadId, threadId);
    assert.equal(m.params.processId, "owned-core-command");
    cancellationCommandLive = false;
    item(
      {
        ...command,
        status: "failed",
        processId: "owned-core-command",
        exitCode: 137,
      },
      true,
    );
    return setTimeout(() => reply(m, { terminated: true }), 30);
  }
  reply(m, {});
});
