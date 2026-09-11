// CPU-only negative guards and historical-record selection. These fixtures are
// not supplied to the app and can never qualify an actual delegation result.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  frozen,
  executable,
  requireWindowsAdmission,
  newDelegations,
  assertPreserved,
  preparedSnapshotDefaults,
  assertInitialRecovery,
} from "./supervisor-windows-admission";
import type { AppState } from "../../src/shared/contracts";
const env = {
  SYNORA_ONE_AGENT_AUTHORIZED: "1",
  SYNORA_P13_WINDOWS_GPU_HANDOFF: "1",
  SYNORA_TEST_EXECUTABLE: executable,
  SYNORA_TEST_ENDPOINT: frozen.endpoint,
  SYNORA_TEST_PREPARED_WINDOWS_QA: frozen.prepared,
};
test("c7a7 admission matches inspector and rejects retired c858 paths even with handoff", () => {
  assert.equal(frozen.commit, "c7a7fb873dce16e403cb6b127c32ed5fbdbfd683");
  assert.doesNotThrow(() => requireWindowsAdmission("win32", env, frozen.root));
  const inspector = readFileSync(
    new URL("./supervisor-windows-session.ps1", import.meta.url),
    "utf8",
  );
  assert.ok(inspector.includes(`$exe='${executable}'`));
  const retired = "C:\\Synora_QA_final_20260909_6fe71e6f74ff";
  assert.throws(
    () => requireWindowsAdmission("win32", env, retired),
    /approved frozen Windows QA root/,
  );
  assert.throws(
    () =>
      requireWindowsAdmission(
        "win32",
        {
          ...env,
          SYNORA_TEST_EXECUTABLE:
            retired +
            "\\out\\production-qa-windows-c858d967\\win-unpacked\\Synora Harness Desktop.exe",
        },
        frozen.root,
      ),
    /Exact frozen package required/,
  );
});
test("reject non-Windows, absent handoff, different prepared home, setup and Core overrides", () => {
  assert.throws(
    () => requireWindowsAdmission("linux", env, frozen.root),
    /Windows only/,
  );
  for (const change of [
    { SYNORA_P13_WINDOWS_GPU_HANDOFF: "" },
    { SYNORA_ONE_AGENT_AUTHORIZED: "" },
    { SYNORA_TEST_PREPARED_WINDOWS_QA: "C:\\new-home" },
    { SYNORA_TEST_EXECUTABLE: "electron.exe" },
    { SYNORA_CODEX_BINARY: "replacement.exe" },
    { SYNORA_AUTHORIZE_WINDOWS_SETUP: "1" },
    { SYNORA_QA_RESET_AFTER_SUCCESS: "1" },
    { NODE_OPTIONS: "--require hook.cjs" },
  ])
    assert.throws(() =>
      requireWindowsAdmission("win32", { ...env, ...change }, frozen.root),
    );
});
const before = {
  conversations: [{ id: "prior", messages: [{ text: "retained" }] }],
  delegations: [
    {
      id: "old",
      parentConversationId: "prior",
      workerId: "reader",
      result: "historical",
    },
  ],
  workspaces: [],
  integrations: [],
  presets: [],
  agentHistory: [],
} as unknown as AppState;
test("select exactly one NEW delegation without treating prior history as a new result", () => {
  const after = structuredClone(before);
  const created = {
    id: "new",
    parentConversationId: "owned",
    workerId: "reader",
  } as AppState["delegations"][number];
  after.delegations.unshift(created);
  assertPreserved(before, after);
  assert.deepEqual(newDelegations(before, after, "owned"), [created]);
  assert.throws(() => newDelegations(before, before, "owned"));
  assert.throws(() => newDelegations(before, after, "wrong-owner"));
  after.delegations.push({ ...created, id: "second-new" });
  assert.throws(() => newDelegations(before, after, "owned"));
});
test("reject mutated/deleted historical conversations and delegation outcomes", () => {
  const changed = structuredClone(before);
  changed.conversations[0].messages[0].text = "changed";
  assert.throws(() => assertPreserved(before, changed));
  const deleted = structuredClone(before);
  deleted.delegations = [];
  assert.throws(() => assertPreserved(before, deleted));
});
test("legacy comparison adds only absent Store defaults without mutating raw history", () => {
  const raw = structuredClone(before);
  delete (raw as Partial<AppState>).delegations;
  const original = structuredClone(raw);
  const snapshot = preparedSnapshotDefaults(raw);
  assert.deepEqual(raw, original);
  assert.deepEqual(snapshot.delegations, []);
  assert.equal(snapshot.conversations[0].id, "prior");
  assert.equal(snapshot.conversations[0].messages[0].text, "retained");
  assert.deepEqual(snapshot.conversations[0].messages[0].imageIds, []);
  assert.deepEqual(snapshot.conversations[0].compactions, []);
  assert.deepEqual(preparedSnapshotDefaults(snapshot), snapshot);
  const changed = structuredClone(snapshot);
  changed.conversations[0].messages[0].text = "rewritten";
  assert.throws(() => assertPreserved(snapshot, changed));
});
test("initial recovery permits only revision and absent assistant false flag, not content/IDs/drafts/activity", () => {
  const baseline = preparedSnapshotDefaults(structuredClone(before));
  baseline.revision = 1;
  baseline.conversations[0].messages[0].role = "assistant";
  const after = structuredClone(baseline);
  after.revision = 2;
  after.conversations[0].messages[0].incomplete = false;
  assert.equal(assertInitialRecovery(baseline, after).length, 2);
  for (const change of [
    (s: AppState) => {
      s.conversations[0].messages[0].text = "replacement";
    },
    (s: AppState) => {
      s.conversations[0].messages[0].id = "replacement";
    },
    (s: AppState) => {
      s.conversations[0].draft = "replacement";
    },
    (s: AppState) => {
      s.conversations[0].messages[0].incomplete = true;
    },
    (s: AppState) => {
      s.conversations[0].activity.push({
        id: "replacement",
        type: "reasoning",
        summary: [],
        content: [],
      });
    },
  ]) {
    const changed = structuredClone(after);
    change(changed);
    assert.throws(() => assertInitialRecovery(baseline, changed));
  }
});
