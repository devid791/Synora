// One-time local provisioning only; writes a NEW empty catalog, never replaces
// an existing one or authorizes an untested Core release.
import { readFile, writeFile } from "node:fs/promises";
import { createPublicKey, sign } from "node:crypto";
import assert from "node:assert/strict";
import { CORE_CHANNEL_ADAPTER, CORE_CHANNEL_KEY_ID, CORE_CHANNEL_PUBLIC_KEY,
  channelPayloadSchema, verifyCoreChannel } from "../src/engine/core-channel";
const output = process.argv[2], keyFile = process.env.SYNORA_CHANNEL_SIGNING_KEY_FILE;
assert.ok(output && keyFile, "Usage: SYNORA_CHANNEL_SIGNING_KEY_FILE=PRIVATE_KEY tsx scripts/bootstrap-core-channel.ts NEW_OUTPUT");
const key = await readFile(keyFile);
assert.equal(createPublicKey(key).export({ type: "spki", format: "pem" }).toString().trim(), CORE_CHANNEL_PUBLIC_KEY.trim());
const now = Date.now();
const payload = channelPayloadSchema.parse({ schema: "synora.core-channel.v1", adapter: CORE_CHANNEL_ADAPTER,
  sequence: now, issuedAt: now, expiresAt: now + 7 * 86400000, releases: [] });
const bytes = Buffer.from(JSON.stringify(payload));
const envelope = { keyId: CORE_CHANNEL_KEY_ID, payload: bytes.toString("base64"), signature: sign(null, bytes, key).toString("base64") };
verifyCoreChannel(envelope);
await writeFile(output, JSON.stringify(envelope) + "\n", { mode: 0o644, flag: "wx" });
console.log("Signed empty bootstrap catalog created; no Core releases authorized.");
