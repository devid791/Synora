// Signing job only. QA workers never receive this private key.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createPublicKey, sign } from "node:crypto";
import assert from "node:assert/strict";
import { coreQualificationSchema, qualifiedFromReport } from "../src/engine/core-qualification";
import { CORE_CHANNEL_ADAPTER, CORE_CHANNEL_KEY_ID, CORE_CHANNEL_PUBLIC_KEY,
  channelPayloadSchema, verifyCoreChannel, coreEvidenceHash } from "../src/engine/core-channel";
import { mergeQualifiedReleases } from "./core-channel-merge";
import { centralCoreReportSchema, centrallyQualifiedFromReport } from "../src/engine/core-central-qualification";

const [output, previousPath, ...reports] = process.argv.slice(2);
assert.ok(output && previousPath && reports.length >= 1 && reports.length <= 3,
  "Usage: tsx scripts/sign-core-channel.ts OUTPUT PREVIOUS_OR_NONE QUALIFIED_REPORT [QUALIFIED_REPORT ...]");
const keyPath = process.env.SYNORA_CHANNEL_SIGNING_KEY_FILE;
assert.ok(keyPath, "Signing requires a protected private key file, never a source-controlled key");
const key = await readFile(keyPath);
assert.equal(createPublicKey(key).export({ type: "spki", format: "pem" }).toString().trim(), CORE_CHANNEL_PUBLIC_KEY.trim());
const now = Date.now();
const previous = previousPath === "none" ? undefined :
  verifyCoreChannel(JSON.parse(await readFile(previousPath, "utf8"))).payload;
const entries = [];
const sourceCommits: string[] = [];
for (const path of reports) {
  const bytes = await readFile(path), value = JSON.parse(bytes.toString());
  const central = value.schema === "synora.core-central-qualification.v1";
  const report = central ? centralCoreReportSchema.parse(value) : coreQualificationSchema.parse(value);
  if (process.env.CI_COMMIT_SHA) assert.equal(report.sourceCommit, process.env.CI_COMMIT_SHA, "Report must belong to this pipeline source");
  sourceCommits.push(report.sourceCommit);
  if (process.env.CORE_VERSION) assert.equal(report.package.version, process.env.CORE_VERSION, "Report must qualify the discovered candidate");
  if (process.env.CORE_TARGET) assert.equal(report.package.target, process.env.CORE_TARGET, "Report must qualify the selected platform");
  for (const gate of report.gates) {
    const evidence = await readFile(join(dirname(resolve(path)), gate.artifact));
    assert.equal(coreEvidenceHash(evidence), gate.sha256, `Changed evidence: ${gate.gate}`);
  }
  const release = central ? centrallyQualifiedFromReport(bytes, now) : qualifiedFromReport(bytes, now);
  const old = previous?.releases.find(r => r.package.target === release.package.target && r.package.version === release.package.version);
  if (old) assert.deepEqual(release.package, old.package, "Published versions are immutable");
  entries.push(old ?? release);
}
assert.equal(new Set(entries.map(r => r.package.target)).size, reports.length, "Duplicate platform report");
assert.equal(new Set(entries.map(r => r.package.version)).size, 1, "Platform versions must match");
// Use the new reports' source commit, not retained older receipt commits.
assert.equal(new Set(sourceCommits).size, 1, "Platforms must test the same adapter source");
const payload = channelPayloadSchema.parse({ schema: "synora.core-channel.v2", adapter: CORE_CHANNEL_ADAPTER,
  sequence: Math.max(now, (previous?.sequence ?? 0) + 1), issuedAt: now, expiresAt: now + 7 * 86400000,
  releases: mergeQualifiedReleases(previous, entries) });
const bytes = Buffer.from(JSON.stringify(payload));
const envelope = { keyId: CORE_CHANNEL_KEY_ID, payload: bytes.toString("base64"), signature: sign(null, bytes, key).toString("base64") };
verifyCoreChannel(envelope);
await writeFile(output, JSON.stringify(envelope) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ version: entries[0].package.version, platforms: entries.map(r => r.package.target), sequence: payload.sequence }));
