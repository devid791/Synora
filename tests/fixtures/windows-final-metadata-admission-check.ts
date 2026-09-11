// QA-overlay guard checks only: no Core/app launch, OS changes or model calls.
// Run explicitly; this file does not add/replace a frozen local-suite case.
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { windowsFinalMetadataFixture } from "./windows-final-metadata";

assert.equal(process.platform, "win32", "No substitute-platform guard pass");
const root = "C:\\Synora_QA_final_20260909_6fe71e6f74ff";
assert.equal(process.cwd(), root);
const executable = join(
  root,
  "out/production-qa-windows-c858d967/win-unpacked/Synora Harness Desktop.exe",
);
process.env.SYNORA_WINDOWS_FINAL_QA_ROOT = root;
process.env.SYNORA_WINDOWS_FINAL_SOURCE_COMMIT =
  "c858d96739122c854083d288f26acc94064c16d7";
process.env.SYNORA_WINDOWS_FINAL_ASAR_SHA256 =
  "6b620623cb57b47bbd0522e8d44dc062acb7e4ab1d06e7ad263005c03c8f6e9e";
delete process.env.SYNORA_QA_NETWORK_PROOF;
const ownedState = async () =>
  (await readdir(tmpdir()))
    .filter((name) => name.startsWith("synora-windows-final-metadata-"))
    .sort();

test("metadata guard rejects an absent packaged executable before fixture creation", async () => {
  const before = await ownedState();
  delete process.env.SYNORA_TEST_EXECUTABLE;
  await assert.rejects(
    windowsFinalMetadataFixture(true),
    /A packaged executable is required; no development fallback/,
  );
  assert.deepEqual(await ownedState(), before);
});

test("exact frozen Windows package rejects missing OS egress proof before Core or fixture creation", async () => {
  const before = await ownedState();
  process.env.SYNORA_TEST_EXECUTABLE = executable;
  await assert.rejects(windowsFinalMetadataFixture(true), (error: unknown) => {
    assert.ok(error instanceof assert.AssertionError);
    assert.equal(error.actual, "");
    assert.equal(error.operator, "match");
    assert.equal(
      String(error.expected),
      String(/^C:\\ProgramData\\Synora-QA-Network\\[0-9a-f]{32}\\proof.json$/),
    );
    return true;
  });
  assert.deepEqual(await ownedState(), before);
});
