// Signing job only. QA workers never receive this private key.
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname, join } from "node:path";
import { createPublicKey, sign } from "node:crypto";
import assert from "node:assert/strict";
import { coreQualificationSchema, qualifiedFromReport } from "../src/engine/core-qualification";
import { CORE_CHANNEL_ADAPTER, CORE_CHANNEL_KEY_ID, CORE_CHANNEL_PUBLIC_KEY,
  channelPayloadSchema, verifyCoreChannel, coreEvidenceHash } from "../src/engine/core-channel";

const [output, previousPath, ...reports] = process.argv.slice(2);
assert.ok(output && previousPath && reports.length === 3,
  "Usage: tsx scripts/sign-core-channel.ts OUTPUT PREVIOUS_OR_NONE MAC_REPORT WINDOWS_REPORT LINUX_REPORT");
const keyPath = process.env.SYNORA_CHANNEL_SIGNING_KEY_FILE;
assert.ok(keyPath, "Signing requires a protected private key file, never a source-controlled key");
const key = await readFile(keyPath);
assert.equal(createPublicKey(key).export({ type: "spki", format: "pem" }).toString().trim(), CORE_CHANNEL_PUBLIC_KEY.trim());
const now = Date.now();
const previous = previousPath === "none" ? undefined :
  verifyCoreChannel(JSON.parse(await readFile(previousPath, "utf8"))).payload;
const entries = [];
for (const path of reports) {
  const bytes = await readFile(path), report = coreQualificationSchema.parse(JSON.parse(bytes.toString()));
  for (const gate of report.gates) {
    const evidence = await readFile(join(dirname(resolve(path)), gate.artifact));
    assert.equal(coreEvidenceHash(evidence), gate.sha256, `Changed evidence: ${gate.gate}`);
  }
  const release = qualifiedFromReport(bytes, now);
  const old = previous?.releases.find(r => r.package.target === release.package.target && r.package.version === release.package.version);
  if (old) assert.deepEqual(release.package, old.package, "Published versions are immutable");
  entries.push(old ?? release);
}
assert.equal(new Set(entries.map(r => r.package.target)).size, 3, "All three native platforms must pass");
assert.equal(new Set(entries.map(r => r.package.version)).size, 1, "Platform versions must match");
// Use the new reports' source commit, not retained older receipt commits.
const sourceCommits = await Promise.all(reports.map(async p => coreQualificationSchema.parse(JSON.parse(await readFile(p, "utf8"))).sourceCommit));
assert.equal(new Set(sourceCommits).size, 1, "Platforms must test the same adapter source");
const payload = channelPayloadSchema.parse({ schema: "synora.core-channel.v1", adapter: CORE_CHANNEL_ADAPTER,
  sequence: Math.max(now, (previous?.sequence ?? 0) + 1), issuedAt: now, expiresAt: now + 7 * 86400000,
  releases: entries });
const bytes = Buffer.from(JSON.stringify(payload));
const envelope = { keyId: CORE_CHANNEL_KEY_ID, payload: bytes.toString("base64"), signature: sign(null, bytes, key).toString("base64") };
verifyCoreChannel(envelope);
await writeFile(output, JSON.stringify(envelope) + "\n", { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ version: entries[0].package.version, platforms: entries.map(r => r.package.target), sequence: payload.sequence }));
