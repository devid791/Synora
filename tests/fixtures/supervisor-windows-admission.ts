// QA sidecar: frozen-artifact and existing-home admission, never a runtime hook.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { win32, resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppState } from "../../src/shared/contracts";

// Mill's raw receipt and read-only builder hashes verified 2026-09-09 23:32 UTC.
// Artifact admission is not permission to run: explicit owner/GPU handoff first.
export const frozen = {
  commit: "c7a7fb873dce16e403cb6b127c32ed5fbdbfd683",
  root: "C:\\Synora_QA_c7a7fb8_20260909_6774e0336697",
  prepared:
    "C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-Mb5PPy",
  exeSha256: "8028a6474d108161965f5922e264658586e72bd0f8117c0f7a30de1e5dfd6de3",
  asarSha256:
    "8ebb0b9a50d3ebb19f04c230f4b991c17b18d51d1ab0401ede26c2ab7f8eae81",
  coreSha256:
    "444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b",
  bindingSha256:
    "076351d7ede73b7d986135ab81ede4f5d849dd667d71b4ca4227ffd7653655b4",
  sandboxSha256:
    "e4a62e26a2d84d09696946d8b65c3737529e48e0da7aa5e98cea3bfed25edb1f",
  setupSha256:
    "a9293d6c496acef647603f309ad9cb4381f8a8def437f1444f0102a03c7a4d02",
  endpoint: "http://10.23.45.10:8015/codex/v1",
};
export const executable = win32.join(
  frozen.root,
  "out/production-qa-windows-c7a7fb8/win-unpacked/Synora Harness Desktop.exe",
);
export const asar = win32.join(win32.dirname(executable), "resources/app.asar");
export const dataRoot = win32.join(frozen.prepared, "state");
export const coreHome = win32.join(dataRoot, "app-server/native-axiom");
export const core = win32.join(
  dataRoot,
  "core-runtime/0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a/bin/codex.exe",
);
const binding = win32.join(dataRoot, "app-server/.windows-home.json");
const sandbox = win32.join(coreHome, ".sandbox-secrets/sandbox_users.json");
const setup = win32.join(coreHome, ".sandbox/setup_marker.json");
export const hashFile = async (file: string) =>
  createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
const same = (a: string, b: string) =>
  win32.resolve(a).toLowerCase() === win32.resolve(b).toLowerCase();

// The default arguments cannot be replaced by the packaged fixture. Parameters
// exist only to CPU-test negative admission without launching an app/Core.
export function requireWindowsAdmission(
  platform = process.platform,
  env = process.env,
  cwd = process.cwd(),
) {
  assert.equal(
    platform,
    "win32",
    "Windows only; no substitute-platform execution",
  );
  assert.equal(
    env.SYNORA_ONE_AGENT_AUTHORIZED,
    "1",
    "Explicit one-reader authorization required",
  );
  assert.equal(
    env.SYNORA_P13_WINDOWS_GPU_HANDOFF,
    "1",
    "Wait for explicit Windows GPU handoff",
  );
  assert.ok(same(cwd, frozen.root), "Use the approved frozen Windows QA root");
  assert.ok(
    same(env.SYNORA_TEST_EXECUTABLE ?? "", executable),
    "Exact frozen package required",
  );
  assert.ok(
    same(env.SYNORA_TEST_PREPARED_WINDOWS_QA ?? "", frozen.prepared),
    "Reuse the prepared home IN PLACE",
  );
  assert.equal(env.SYNORA_TEST_ENDPOINT, frozen.endpoint);
  for (const key of [
    "SYNORA_AUTHORIZE_WINDOWS_SETUP",
    "SYNORA_CODEX_BINARY",
    "SYNORA_QA_CORE_LAUNCHER",
    "SYNORA_QA_RESET_AFTER_SUCCESS",
    "NODE_OPTIONS",
    "ELECTRON_RUN_AS_NODE",
  ])
    assert.ok(
      !env[key],
      `Refusing inherited ${key}; no setup/reset/Core or runtime override`,
    );
  assert.notEqual(
    frozen.commit,
    "c858d96739122c854083d288f26acc94064c16d7",
    "Retired c858 candidate is not authorized for this P13 qualification",
  );
}
async function regular(file: string) {
  const info = await lstat(file);
  assert.ok(
    info.isFile() && !info.isSymbolicLink(),
    `Not a regular owned file: ${file}`,
  );
  assert.ok(
    same(await realpath(file), file),
    `Linked or aliased target: ${file}`,
  );
}
export async function protectedIdentity() {
  for (const directory of [
    frozen.prepared,
    dataRoot,
    win32.dirname(binding),
    coreHome,
  ]) {
    const info = await lstat(directory);
    assert.ok(info.isDirectory() && !info.isSymbolicLink());
    assert.ok(
      same(await realpath(directory), directory),
      "Prepared home must not be an alias/link",
    );
  }
  for (const file of [executable, asar, core, binding, sandbox, setup])
    await regular(file);
  const actual = {
    exeSha256: await hashFile(executable),
    asarSha256: await hashFile(asar),
    coreSha256: await hashFile(core),
    bindingSha256: await hashFile(binding),
    sandboxSha256: await hashFile(sandbox),
    setupSha256: await hashFile(setup),
  };
  for (const key of Object.keys(actual) as (keyof typeof actual)[])
    assert.equal(
      actual[key],
      frozen[key],
      `Frozen package/prepared-home identity changed: ${key}`,
    );
  assert.deepEqual(JSON.parse(await readFile(binding, "utf8")), {
    schema: "synora.windows-core-home.v1",
    relative: "app-server/native-axiom",
  });
  const runtime = JSON.parse(
    await readFile(win32.join(dataRoot, "runtime-updates/active.json"), "utf8"),
  );
  assert.deepEqual(runtime.active, { version: "0.153.4", generation: null });
  assert.ok(
    !runtime.restoreState && !runtime.restoreTrees,
    "Pending runtime recovery cannot be consumed by this test",
  );
  return actual;
}
type WindowsProcess = {
  ProcessId: number;
  ParentProcessId: number;
  Name: string;
  SessionId: number;
  ExecutablePath: string | null;
};
export async function inspectSession(appPid = 0) {
  assert.equal(process.platform, "win32");
  const result = await promisify(execFile)(
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    ),
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      resolve("tests/fixtures/supervisor-windows-session.ps1"),
      "-AppPid",
      String(appPid),
    ],
    { timeout: 15000, windowsHide: true, maxBuffer: 512 * 1024 },
  );
  const r = JSON.parse(result.stdout.replace(/^\uFEFF/, "").trim()) as {
    at: string;
    identity: string;
    sessionId: number;
    elevated: boolean;
    mediumIntegrity: boolean;
    runnerPid: number;
    appPid: number;
    related: WindowsProcess[];
    children: WindowsProcess[];
  };
  assert.equal(r.runnerPid, process.pid);
  assert.equal(r.sessionId, 1);
  assert.equal(r.elevated, false);
  assert.equal(r.mediumIntegrity, true);
  assert.equal(r.appPid, appPid);
  return r;
}
export function readPreparedState(): AppState {
  // Open existing DB read-only. No service instantiation, migration or seeding.
  const db = new DatabaseSync(win32.join(dataRoot, "state.sqlite"), {
    readOnly: true,
  });
  try {
    const row = db.prepare("SELECT data FROM state WHERE id=1").get();
    assert.equal(typeof row?.data, "string");
    return preparedSnapshotDefaults(
      JSON.parse(row!.data as string) as AppState,
    );
  } finally {
    db.close();
  }
}
export function preparedSnapshotDefaults(raw: AppState): AppState {
  // Pure comparison snapshot: mirror only Store.read's absent-field defaults.
  // Never write this object to the DB/app or manufacture any event/result/ID.
  const state = structuredClone(raw);
  if (state.delegations === undefined) state.delegations = [];
  if (state.agentHistory === undefined) state.agentHistory = [];
  for (const conversation of state.conversations) {
    for (const key of [
      "compactions",
      "attachments",
      "draftImageIds",
      "backendRequests",
      "activity",
      "itemOrder",
    ] as const)
      if (conversation[key] === undefined) conversation[key] = [];
    for (const message of conversation.messages)
      if (message.imageIds === undefined) message.imageIds = [];
  }
  for (const agent of state.agentHistory) {
    if (agent.closed === undefined) agent.closed = false;
    if (agent.activity === undefined) agent.activity = [];
    if (agent.backendRequests === undefined) agent.backendRequests = [];
  }
  if (state.preferences && state.preferences.mode === undefined)
    state.preferences.mode = "default";
  return state;
}
export function assertInitialRecovery(before: AppState, after: AppState) {
  const expected = structuredClone(before);
  const differences: { path: string; before: unknown; after: unknown }[] = [];
  const original = expected.conversations[0];
  const recovered = after.conversations.find((c) => c.id === original.id);
  assert.ok(
    recovered,
    "Initial recovery lost the selected historical conversation",
  );
  // mergeMessage(..., 'history') materializes absent assistant incomplete=false.
  // This does not permit edits to text, IDs, drafts, ordering, true flags, tools,
  // timing/output, bindings, or metrics; all other persisted fields stay exact.
  for (const message of original.messages) {
    const next = recovered.messages.find((m) => m.id === message.id);
    if (
      message.role === "assistant" &&
      message.incomplete === undefined &&
      next?.incomplete === false
    ) {
      differences.push({
        path: `conversations/${original.id}/messages/${message.id}/incomplete`,
        before: "<absent>",
        after: false,
      });
      message.incomplete = false;
    }
  }
  assert.ok(
    Number.isInteger(after.revision) && after.revision >= before.revision,
  );
  if (after.revision !== before.revision)
    differences.push({
      path: "revision",
      before: before.revision,
      after: after.revision,
    });
  expected.revision = after.revision;
  assert.deepEqual(
    after,
    expected,
    "Initial recovery changed substantive saved state",
  );
  return differences;
}
export function assertPreserved(before: AppState, after: AppState) {
  for (const key of [
    "conversations",
    "delegations",
    "workspaces",
    "integrations",
    "presets",
    "agentHistory",
  ] as const) {
    for (const value of before[key])
      assert.deepEqual(
        after[key].find((entry) => entry.id === value.id),
        value,
        `Existing ${key} record changed: ${value.id}`,
      );
  }
}
export function newDelegations(
  before: AppState,
  after: AppState,
  conversationId: string,
) {
  const ids = new Set(before.delegations.map((task) => task.id));
  const created = after.delegations.filter((task) => !ids.has(task.id));
  assert.equal(
    created.length,
    1,
    "Exactly one NEW delegation; preserve prior history",
  );
  assert.equal(created[0].parentConversationId, conversationId);
  assert.equal(created[0].workerId, "reader");
  return created;
}
