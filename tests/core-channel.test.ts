import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CoreChannel, CORE_CHANNEL_ADAPTER, CORE_CHANNEL_KEY_ID, CORE_CHANNEL_URL,
  verifyCoreChannel, channelPayloadSchema, type CoreChannelPayload,
} from "../src/engine/core-channel";
import { corePackage } from "../src/engine/core-runtime";
import { REQUIRED_CORE_GATES } from "../src/engine/qualified-core";
import { CoreUpdater } from "../src/engine/core-updater";
import { updaterFixture } from "./core-updater-fixture";

const keys = generateKeyPairSync("ed25519");
const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const now = 1800000000000;
function payload(): CoreChannelPayload {
  return channelPayloadSchema.parse({
    schema: "synora.core-channel.v1", adapter: CORE_CHANNEL_ADAPTER,
    sequence: 1, issuedAt: now - 1000, expiresAt: now + 3600000,
    releases: [{ package: { ...structuredClone(corePackage()), version: "0.155.0" }, protocol: "0.153.4",
      qualification: { sourceCommit: "a".repeat(40), evidenceSha256: "b".repeat(64), checks: [...REQUIRED_CORE_GATES] } }],
  });
}
function signed(p: unknown) {
  const bytes = Buffer.from(JSON.stringify(p));
  return { keyId: CORE_CHANNEL_KEY_ID, payload: bytes.toString("base64"), signature: sign(null, bytes, keys.privateKey).toString("base64") };
}
async function fixture(t: { after(f: () => Promise<void>): void }) {
  const root = await mkdtemp(join(tmpdir(), "synora-channel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  let value: unknown = signed(payload()), time = now;
  const options = { publicKey, now: () => time,
    fetch: (async (url, init) => {
      assert.equal(url, CORE_CHANNEL_URL);
      assert.equal(init?.redirect, "error");
      assert.equal(init?.cache, "no-store");
      return Response.json(value);
    }) as typeof fetch };
  const channel = new CoreChannel(root, options);
  return { root, channel, options, set: (v: unknown) => { value = v; }, time: (n: number) => { time = n; } };
}
test("signed channel discovers a new version without extending compiled allowlist", async t => {
  const f = await fixture(t);
  assert.equal(f.channel.candidates().length, 0);
  assert.equal((await f.channel.refresh(new AbortController().signal))[0].package.version, "0.155.0");
  await f.channel.retain("0.155.0");
  f.time(now + 7200000);
  const reopened = new CoreChannel(f.root, f.options);
  assert.equal(reopened.candidates().length, 0);
  assert.equal(reopened.installed("0.155.0").package.version, "0.155.0");
  await assert.rejects(reopened.retain("0.155.0"), /expired/);
});
test("channel verifies exact signed bytes, pinned key identity and no extra fields", () => {
  const envelope = signed(payload());
  assert.equal(verifyCoreChannel(envelope, publicKey).payload.sequence, 1);
  assert.throws(() => verifyCoreChannel(envelope), /signature/);
  assert.throws(() => verifyCoreChannel({ ...envelope, keyId: "attacker" }, publicKey));
  assert.throws(() => verifyCoreChannel({ ...envelope, url: "https://attacker.invalid" }, publicKey));
  assert.throws(() => verifyCoreChannel({ ...envelope, payload: Buffer.from(JSON.stringify({ ...payload(), sequence: 2 })).toString("base64") }, publicKey), /signature/);
});
for (const [name, change] of Object.entries<(p: any) => void>({
  "protocol mismatch": p => { p.releases[0].protocol = "0.999.0"; },
  "adapter mismatch": p => { p.adapter = "unknown"; },
  "missing gate": p => { p.releases[0].qualification.checks.pop(); },
  "duplicate gate": p => { p.releases[0].qualification.checks[0] = "ui"; },
  "missing evidence": p => { p.releases[0].qualification.evidenceSha256 = ""; },
  "prerelease": p => { p.releases[0].package.version = "0.155.0-alpha.1"; },
  "unsafe asset": p => { p.releases[0].package.file = "../../run.tar.gz"; },
  "unsafe payload": p => { p.releases[0].package.files["../escape"] = [1, "a".repeat(64)]; },
  "case collision": p => { p.releases[0].package.files["CODEX-PACKAGE.JSON"] = [1, "a".repeat(64)]; },
  "duplicate version": p => { p.releases.push(p.releases[0]); },
  "unbounded validity": p => { p.expiresAt = now + 30 * 86400000; },
  "unsafe integer": p => { p.sequence = 1e30; },
})) test(`channel rejects ${name} even with a valid signature`, () => {
  const p = payload(); change(p);
  assert.throws(() => verifyCoreChannel(signed(p), publicKey));
});
test("expiry, future issue, replay, same-sequence equivocation and repacked versions fail closed", async t => {
  const f = await fixture(t), p = payload();
  await f.channel.refresh(new AbortController().signal);
  for (const bad of [
    { ...p, sequence: 2, issuedAt: now - 2000, expiresAt: now - 1000 },
    { ...p, sequence: 2, issuedAt: now + 600000 },
    { ...p, issuedAt: now - 2000 },
    { ...p, sequence: 2, releases: [{ ...p.releases[0], package: { ...p.releases[0].package, sha256: "d".repeat(64) } }] },
  ]) {
    f.set(signed(bad));
    await assert.rejects(f.channel.refresh(new AbortController().signal));
    assert.equal(f.channel.candidates()[0].package.sha256, p.releases[0].package.sha256);
  }
  f.set(signed({ ...p, sequence: 2 }));
  await f.channel.refresh(new AbortController().signal);
  f.set(signed(p));
  await assert.rejects(new CoreChannel(f.root, f.options).refresh(new AbortController().signal), /replay/);
});
test("a withdrawn version cannot be installed, but its retained authorization survives", async t => {
  const f = await fixture(t);
  await f.channel.refresh(new AbortController().signal);
  await f.channel.retain("0.155.0");
  f.set(signed({ ...payload(), sequence: 2, releases: [] }));
  await f.channel.refresh(new AbortController().signal);
  assert.deepEqual(f.channel.candidates(), []);
  assert.equal(f.channel.installed("0.155.0").package.version, "0.155.0");
  await assert.rejects(f.channel.retain("0.155.0"));
  const replaced = payload(); replaced.sequence = 3;
  replaced.releases[0].package.sha256 = "e".repeat(64);
  f.set(signed(replaced));
  await assert.rejects(f.channel.refresh(new AbortController().signal), /retained version/);
});
test("a catalog for a different platform does not authorize installation", async t => {
  const f = await fixture(t);
  const channel = new CoreChannel(f.root, { ...f.options, target: "unsupported-target" });
  assert.deepEqual(await channel.refresh(new AbortController().signal), []);
});
test("corrupt on-disk trust data cannot reset the highest accepted sequence", async t => {
  const f = await fixture(t);
  await f.channel.refresh(new AbortController().signal);
  await writeFile(join(f.root, "runtime-updates/channel/catalog.json"), "{}");
  const channel = new CoreChannel(f.root, f.options);
  assert.deepEqual(channel.candidates(), []);
  await assert.rejects(channel.refresh(new AbortController().signal), /Saved Core channel/);
});
test("bounded download rejects oversized metadata and preserves the previous catalog", async t => {
  const f = await fixture(t);
  await f.channel.refresh(new AbortController().signal);
  const before = await readFile(join(f.root, "runtime-updates/channel/catalog.json"), "utf8");
  const channel = new CoreChannel(f.root, { ...f.options, fetch: (async () => new Response("x".repeat(2 * 1024 * 1024 + 1))) as typeof fetch });
  await assert.rejects(channel.refresh(new AbortController().signal), /size limit/);
  assert.equal(await readFile(join(f.root, "runtime-updates/channel/catalog.json"), "utf8"), before);
});
test("signed candidate activates through real updater transaction and restarts offline after expiry", async t => {
  const f = await fixture(t), packages = await updaterFixture(f.root);
  const release = packages.releases.get("0.153.5")!.release;
  f.set(signed({ ...payload(), releases: [release] }));
  const options = { ...packages.options, lookup: undefined, channel: f.channel };
  const updater = new CoreUpdater(f.root, options);
  const hooks = { idle() {}, async pause() {}, resume() {}, state: () => ({}), restore() {} };
  assert.equal(updater.snapshot().eligibleVersion, null);
  await updater.check();
  assert.equal(updater.snapshot().eligibleVersion, "0.153.5");
  await updater.install("0.153.5", hooks);
  assert.equal(updater.selection().version, "0.153.5");
  await updater.dispose();
  f.time(now + 7200000);
  const reopened = new CoreUpdater(f.root, { ...options, channel: new CoreChannel(f.root, f.options) });
  t.after(() => reopened.dispose());
  assert.equal(reopened.selection().version, "0.153.5");
  assert.ok(await reopened.selection().executable());
});
test("new signed releases auto-install only after busy sessions become idle", async t => {
  const f = await fixture(t), packages = await updaterFixture(f.root);
  f.set(signed({ ...payload(), releases: [packages.releases.get("0.153.5")!.release] }));
  let busy = true, pauses = 0;
  const updater = new CoreUpdater(f.root, { ...packages.options, lookup: undefined, channel: f.channel,
    initialDelayMs: 5, idleRetryMs: 10, intervalMs: 10000 });
  t.after(() => updater.dispose());
  updater.start({ idle() { if (busy) throw Error("Live turn"); }, async pause() { pauses++; }, resume() {}, state: () => ({}), restore() {} });
  for (let n = 0; n < 100 && updater.snapshot().eligibleVersion === null; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(updater.snapshot().eligibleVersion, "0.153.5");
  assert.equal(updater.selection().version, "0.153.4"); assert.equal(pauses, 0);
  busy = false;
  for (let n = 0; n < 400 && updater.selection().version === "0.153.4"; n++) await new Promise(r => setTimeout(r, 10));
  assert.equal(updater.selection().version, "0.153.5"); assert.equal(pauses, 1);
});
test("authorization expiring during local probe cannot activate a downloaded candidate", async t => {
  const f = await fixture(t), packages = await updaterFixture(f.root);
  f.set(signed({ ...payload(), releases: [packages.releases.get("0.153.5")!.release] }));
  const updater = new CoreUpdater(f.root, { ...packages.options, lookup: undefined, channel: f.channel,
    probe: async () => { f.time(now + 7200000); } });
  t.after(() => updater.dispose());
  await updater.check();
  await assert.rejects(updater.install("0.153.5", { idle() {}, async pause() {}, resume() {}, state: () => ({}), restore() {} }), /authorization expired/);
  assert.equal(updater.selection().version, "0.153.4");
});
