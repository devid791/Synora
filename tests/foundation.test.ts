import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { Store } from "../src/main/store";
import {
  readFile,
  saveFile,
  listFiles,
  resolveWorkspacePath,
} from "../src/main/workspace";
import { Simulator } from "../src/engine/simulator";
import {
  presetSchema,
  configSchema,
  type EventEnvelope,
  type Scenario,
} from "../src/shared/contracts";

const schema = JSON.parse(
  await fs.readFile(
    new URL(
      "../docs/protocol/codex-0.153.4/ServerNotification.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const approvalSchema = JSON.parse(
  await fs.readFile(
    new URL(
      "../docs/protocol/codex-0.153.4/CommandExecutionRequestApprovalParams.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const ajv = new Ajv({
  strictSchema: true,
  strictTypes: false,
  strictTuples: false,
  strictRequired: false,
  allErrors: true,
});
addFormats(ajv);
for (const [format, min, max] of [
  ["uint", 0, Number.MAX_SAFE_INTEGER],
  ["uint16", 0, 65535],
  ["uint32", 0, 4294967295],
  ["uint64", 0, Number.MAX_SAFE_INTEGER],
  ["int32", -2147483648, 2147483647],
  ["int64", Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
] as const)
  ajv.addFormat(format, {
    type: "number",
    validate: (value: number) =>
      Number.isSafeInteger(value) && value >= min && value <= max,
  });
const validate = ajv.compile(schema),
  validateApproval = ajv.compile(approvalSchema);
const pause = (n: number) => new Promise((resolve) => setTimeout(resolve, n));
const fixture = {
  schema: "synora.bot.v1" as const,
  name: "Researcher",
  description: "Local preset",
  instructions: "Review the selected project",
  kind: "research" as const,
  profile: "medium" as const,
  context: 262144 as const,
  connectorIds: [],
  enabled: true,
};

test("SQLite state persists; validation failure rolls back the transaction", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synora-store-"));
  const file = path.join(dir, "state.sqlite");
  let store = new Store(file);
  try {
    store.preferences({ compact: true });
    store.preset(fixture);
    const saved = store.read();
    assert.throws(() =>
      store.preset({ ...fixture, extraCommand: "not allowed" }),
    );
    assert.deepEqual(store.read(), saved);
    assert.throws(() => store.preset(fixture));
    store.close();
    store = new Store(file);
    assert.equal(store.read().preferences.compact, true);
    assert.equal(store.read().presets[0].name, "Researcher");
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true });
  }
});

test("Preset and integration schemas reject credentials, unknown fields and unsafe endpoints", () => {
  assert.equal(
    presetSchema.safeParse({ ...fixture, apiKey: "secret" }).success,
    false,
  );
  assert.equal(
    presetSchema.safeParse({ ...fixture, profile: "qwen" }).success,
    false,
  );
  for (const endpoint of [
    "file:///tmp/",
    "https://user:pass@example.org",
    "https://example.org/?token=secret",
    "javascript:alert(1)",
  ])
    assert.equal(
      configSchema.safeParse({
        id: "x",
        name: "X",
        kind: "provider",
        endpoint,
        auth: "none",
        enabled: false,
        tools: [],
      }).success,
      false,
    );
  assert.equal(
    configSchema.safeParse({
      id: "x",
      name: "X",
      kind: "mcp",
      endpoint: "https://example.org/mcp",
      auth: "oauth",
      enabled: false,
      tools: ["read_file"],
    }).success,
    true,
  );
});

test("Workspace paths contain traversal and symlink escape; writes detect conflicting edits", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synora-fs-"));
  const root = path.join(dir, "project");
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "note.txt"), "original");
  await fs.writeFile(path.join(dir, "outside.txt"), "outside");
  if (process.platform === "win32") {
    // Directory junctions test the same realpath boundary without granting
    // the Windows account a system-wide symbolic-link privilege.
    await fs.symlink(dir, path.join(root, "escape"), "junction");
  } else {
    await fs.symlink(path.join(dir, "outside.txt"), path.join(root, "escape"));
  }
  const workspace = { id: "w", name: "Test", path: root };
  try {
    await assert.rejects(resolveWorkspacePath(workspace, "../outside.txt"));
    await assert.rejects(resolveWorkspacePath(workspace, "escape"));
    await assert.rejects(resolveWorkspacePath(workspace, "/etc/passwd"));
    assert.deepEqual(
      (await listFiles(workspace, "")).map((f) => f.name),
      ["note.txt"],
    );
    const document = await readFile(workspace, "note.txt");
    const saved = await saveFile(workspace, { ...document, content: "saved" });
    assert.equal(saved.content, "saved");
    await fs.writeFile(path.join(root, "note.txt"), "external");
    await assert.rejects(
      saveFile(workspace, { ...saved, content: "must not clobber" }),
    );
    assert.equal(
      await fs.readFile(path.join(root, "note.txt"), "utf8"),
      "external",
    );
  } finally {
    await fs.rm(dir, { recursive: true });
  }
});

for (const scenario of ["text", "tool", "agents", "failure"] as const)
  test(`Simulator ${scenario}: notifications validate against Codex 0.153.4`, async () => {
    const events: EventEnvelope[] = [];
    const simulator = new Simulator((e) => events.push(e), 0.015);
    try {
      const initial = simulator.start("test-thread", "Hello", scenario);
      assert.ok(initial.turnId);
      for (
        let n = 0;
        n < 200 && ["running", "waiting"].includes(simulator.snapshot().status);
        n++
      )
        await pause(5);
      assert.equal(
        simulator.snapshot().status,
        scenario === "failure" ? "failed" : "completed",
      );
      for (const envelope of events) {
        assert.equal(envelope.simulated, true);
        if (envelope.event.kind === "protocol")
          assert.ok(
            validate(envelope.event.payload),
            JSON.stringify(validate.errors),
          );
      }
      assert.equal(
        events.filter(
          (e) =>
            e.event.kind === "protocol" &&
            e.event.payload.method === "turn/completed",
        ).length,
        1,
      );
      assert.deepEqual(
        events.map((e) => e.sequence),
        events.map((_, i) => i + 1),
      );
      if (scenario === "tool") {
        const items = events
          .flatMap((e) =>
            e.event.kind === "protocol" &&
            ["item/started", "item/completed"].includes(e.event.payload.method)
              ? [
                  (
                    e.event.payload.params as {
                      item: { id: string; type: string };
                    }
                  ).item,
                ]
              : [],
          )
          .filter((i) => i.type === "dynamicToolCall");
        assert.equal(items.length, 2);
        assert.equal(items[0].id, items[1].id);
      }
      if (scenario === "agents")
        assert.ok(
          simulator
            .snapshot()
            .agents.every(
              (a) =>
                a.status === "completed" &&
                a.parentId === "test-thread" &&
                a.simulated,
            ),
        );
    } finally {
      simulator.dispose();
    }
  });

test("Approval accepts exactly the pending request and does not execute a command", async () => {
  const simulator = new Simulator(() => {}, 0.015);
  try {
    const initial = simulator.start("approval-thread", "Approve", "approval");
    assert.equal(initial.status, "waiting");
    assert.ok(
      validateApproval(initial.approval!.params),
      JSON.stringify(validateApproval.errors),
    );
    assert.throws(() => simulator.approve("stale", true));
    simulator.approve(initial.approval!.id, true);
    for (let n = 0; n < 100 && simulator.snapshot().status === "running"; n++)
      await pause(5);
    assert.equal(simulator.snapshot().status, "completed");
    assert.throws(() => simulator.approve(initial.approval!.id, true));
  } finally {
    simulator.dispose();
  }
});

test("Cancellation is terminal and stops further output; repeated cancel is idempotent", async () => {
  const events: EventEnvelope[] = [];
  const simulator = new Simulator((e) => events.push(e), 0.02);
  try {
    simulator.start("cancel-thread", "Cancel", "slow");
    assert.throws(() => simulator.start("other", "No", "text"));
    simulator.cancel();
    const length = events.length;
    await pause(220);
    assert.equal(events.length, length);
    assert.equal(simulator.cancel().status, "interrupted");
    assert.equal(events.length, length);
  } finally {
    simulator.dispose();
  }
});

test("Disconnect finishes independently; snapshot and sequenced replay reconcile state", async () => {
  const events: EventEnvelope[] = [];
  const simulator = new Simulator((e) => events.push(e), 0.015);
  try {
    simulator.start("resume-thread", "Continue", "disconnect");
    await pause(150);
    assert.equal(simulator.snapshot().connection, "disconnected");
    assert.equal(simulator.snapshot().status, "completed");
    const last = events.at(-1)!.sequence;
    assert.ok(
      !events.some(
        (e) =>
          e.event.kind === "protocol" &&
          e.event.payload.method === "turn/completed",
      ),
    );
    const replay = simulator.reconnect(last);
    assert.equal(replay.snapshot.status, "completed");
    assert.ok(
      replay.events.some(
        (e) =>
          e.event.kind === "protocol" &&
          e.event.payload.method === "turn/completed",
      ),
    );
    assert.ok(replay.events.every((e) => e.sequence > last));
    assert.equal(
      replay.snapshot.items.filter((i) => i.type === "agentMessage").length,
      1,
    );
  } finally {
    simulator.dispose();
  }
});
