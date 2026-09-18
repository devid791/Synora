import test from "node:test";
import assert from "node:assert/strict";
import { mergeQualifiedReleases } from "../scripts/core-channel-merge";
import { CORE_CHANNEL_ADAPTER, type CoreChannelPayload } from "../src/engine/core-channel";
import { corePackage } from "../src/engine/core-runtime";
import { REQUIRED_CORE_GATES } from "../src/engine/qualified-core";
type Release = CoreChannelPayload["releases"][number];
function release(target: Release["package"]["target"], version = "0.155.0"): Release {
  return { package: { ...corePackage(), files: Object.fromEntries(Object.entries(corePackage().files).map(([k,v]) => [k, [v[0], v[1]] as [number,string]])), target, version, file: `codex-package-${target}.tar.gz` },
    protocol: "0.153.4", qualification: { sourceCommit: "a".repeat(40), evidenceSha256: "b".repeat(64), checks: [...REQUIRED_CORE_GATES] } };
}
const linux = "x86_64-unknown-linux-musl", mac = "aarch64-apple-darwin", win = "x86_64-pc-windows-msvc";
function previous(releases: Release[]): CoreChannelPayload {
  return { schema: "synora.core-channel.v1", adapter: CORE_CHANNEL_ADAPTER, sequence: 1,
    issuedAt: 1, expiresAt: 2, releases };
}
test("Linux publishes alone; an absent or failed Windows report is never required or authorized", () => {
  assert.deepEqual(mergeQualifiedReleases(undefined, [release(linux)]), [release(linux)]);
});
test("Mac publishes without waiting for Windows and retains the exact Windows and Linux receipts", () => {
  const old = previous([release(win, "0.154.0"), release(linux)]);
  const merged = mergeQualifiedReleases(old, [release(mac)]);
  assert.deepEqual(merged, [...old.releases, release(mac)]);
  assert.equal(merged[0], old.releases[0]);
});
test("an independently published second platform retains the first platform", () => {
  const first = mergeQualifiedReleases(undefined, [release(linux)]);
  assert.deepEqual(mergeQualifiedReleases(previous(first), [release(mac)]), [...first, release(mac)]);
});
test("requalification cannot replace an existing immutable receipt or payload", () => {
  const old = previous([release(linux)]), changed = release(linux);
  changed.qualification.sourceCommit = "c".repeat(40);
  assert.deepEqual(mergeQualifiedReleases(old, [changed]), old.releases);
  changed.package.sha256 = "d".repeat(64);
  assert.throws(() => mergeQualifiedReleases(old, [changed]), /immutable/);
});
test("no empty publication, duplicate platform or delayed downgrade", () => {
  assert.throws(() => mergeQualifiedReleases(undefined, []));
  assert.throws(() => mergeQualifiedReleases(undefined, [release(linux), release(linux)]));
  assert.throws(() => mergeQualifiedReleases(previous([release(linux)]), [release(linux, "0.154.0")]), /downgrade/);
});
test("rolling history stays bounded without removing another platform's only good version", () => {
  const old = previous([release(win, "0.100.0"), ...Array.from({length: 16}, (_, i) => release(linux, `0.${120+i}.0`))]);
  const merged = mergeQualifiedReleases(old, [release(linux)]);
  assert.equal(merged.length, 17);
  assert.equal(merged[0], old.releases[0]);
  assert.equal(merged.filter(r => r.package.target === linux).length, 16);
});
