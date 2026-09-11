import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalReceipt, ownedProcessIds } from "../scripts/mac-install-guards.mjs";

test("inventory includes detached Synora helpers/Core and all visible descendants only", () => {
  const rows = [
    "1 0 /sbin/launchd",
    "40 1 /Applications/Synora Harness Desktop.app/Contents/MacOS/Synora Harness Desktop",
    "60 50 /bin/sh -c qa",
    "50 40 /usr/bin/node qa",
    "70 1 /Applications/Synora Harness Desktop.app/Contents/Frameworks/Synora Helper.app/Contents/MacOS/Synora Helper",
    "80 1 /Users/test/Synora-profile/runtime-updates/bin/codex app-server",
    "90 1 /Applications/Codex.app/Contents/MacOS/Codex",
    "91 1 /usr/bin/node unrelated",
  ].join("\n");
  assert.deepEqual(ownedProcessIds(rows, ["/Applications/Synora Harness Desktop.app/Contents/", "/Users/test/Synora-profile/"]), [40, 50, 60, 70, 80]);
});

test("inventory rejects malformed rows and accepts absence of owned processes", () => {
  assert.throws(() => ownedProcessIds("unparseable", ["/Synora/"]));
  assert.deepEqual(ownedProcessIds("1 0 /sbin/launchd", ["/Synora/"]), []);
});

test("profile boundary catches detached Core with bare, quoted and equals data-dir arguments", () => {
  const profile = "/Users/test/Library/Application Support/Synora Harness Desktop";
  const rows = [
    `10 1 /opt/codex app-server --data-dir="${profile}"`,
    `11 1 /opt/codex app-server --data-dir=${profile}`,
    `12 1 /opt/codex app-server --data-dir '${profile}'`,
    `13 1 ${profile}/runtime-updates/bin/codex app-server`,
    "14 10 /usr/bin/node worker",
    `20 1 /opt/codex app-server --data-dir=${profile}-other`,
    `21 1 /opt/codex app-server --data-dir=/tmp${profile}`,
    "22 1 /opt/codex app-server --data-dir=/Users/other",
  ].join("\n");
  assert.deepEqual(ownedProcessIds(rows, [], [profile]), [10, 11, 12, 13, 14]);
});

test("later exact profile argument is not hidden by an earlier path-lookalike", () => {
  const profile = "/Users/test/Synora";
  assert.deepEqual(ownedProcessIds(`10 1 /opt/codex --old=${profile}-other --data-dir=${profile}`, [], [profile]), [10]);
});

test("receipt rejects traversal, file/parent symlinks and directories", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "synora-install-guard-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = join(root, "native"); await mkdir(run);
  const receipt = join(run, "split-native.json"); await writeFile(receipt, "{}");
  assert.equal(await canonicalReceipt(receipt, root), receipt);
  await assert.rejects(canonicalReceipt(`${root}/native/../native/split-native.json`, root));
  const linked = join(root, "linked"); await symlink(run, linked);
  await assert.rejects(canonicalReceipt(join(linked, "split-native.json"), root));
  const other = join(root, "other"); await mkdir(other);
  const link = join(other, "split-native.json"); await symlink(receipt, link);
  await assert.rejects(canonicalReceipt(link, root));
  await assert.rejects(canonicalReceipt(receipt, other));
  const directory = join(root, "split-native.json"); await mkdir(directory);
  await assert.rejects(canonicalReceipt(directory, root));
});
