import { createHash, verify } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { corePackage } from "./core-runtime";
import { compareCoreVersions, REQUIRED_CORE_GATES, type QualifiedCore } from "./qualified-core";
import { PROTOCOL_VERSION } from "../shared/contracts";

// The transport is not a trust anchor: only this signing key can authorize
// binaries. No renderer, provider, environment variable or release note can
// supply a key, URL, executable or qualification policy.
export const CORE_CHANNEL_URL = "https://synora-ai.org/updates/core/stable-v2.json";
export const CORE_CHANNEL_KEY_ID = "synora-core-20260917";
export const CORE_CHANNEL_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEADszVbqPXbBCgUKzP0J3NOiFrThNsWcXtTLkIshmj4Io=
-----END PUBLIC KEY-----`;
// Bump when changing supported adapter semantics, not for cosmetic app releases.
export const CORE_CHANNEL_ADAPTER = "synora-core-adapter-20260917-v1";
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_LIFETIME = 14 * 24 * 60 * 60 * 1000;
const hex = z.string().regex(/^[a-f0-9]{64}$/);
const version = z.string().refine(v => {
  try { compareCoreVersions(v, v); return true; } catch { return false; }
}, "Invalid stable Core version");
const safeFile = z.string().regex(/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/)
  .refine(v => !v.split("/").some(p => p === "." || p === ".."));
export const CENTRAL_CORE_GATES = ["official-package", "linux-runtime-contract", "provider-contracts"] as const;
export const CENTRAL_CORE_POLICY = "server-compatibility-local-activation-v1";
export const centralQualificationSchema = z.object({
  policy: z.literal(CENTRAL_CORE_POLICY),
  testedTarget: z.literal("x86_64-unknown-linux-musl"),
  localActivation: z.literal("required"),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), evidenceSha256: hex,
  checks: z.array(z.enum(CENTRAL_CORE_GATES)).length(CENTRAL_CORE_GATES.length)
    .refine(v => new Set(v).size === CENTRAL_CORE_GATES.length),
}).strict();
export const channelReleaseSchema = z.object({
  package: z.object({
    version, target: z.enum(["aarch64-apple-darwin", "x86_64-pc-windows-msvc", "x86_64-unknown-linux-musl"]),
    file: z.string().regex(/^codex-package-[a-zA-Z0-9_-]+\.tar\.gz$/),
    size: z.number().int().positive().max(1024 * 1024 * 1024), sha256: hex,
    files: z.record(safeFile, z.tuple([z.number().int().nonnegative().max(2 ** 31), hex]))
      .refine(v => Object.keys(v).length > 0 && Object.keys(v).length <= 4096),
  }).strict(),
  protocol: z.literal(PROTOCOL_VERSION),
  qualification: z.union([z.object({
    sourceCommit: z.string().regex(/^[a-f0-9]{40}$/), evidenceSha256: hex,
    checks: z.array(z.enum(REQUIRED_CORE_GATES)).length(REQUIRED_CORE_GATES.length)
      .refine(v => new Set(v).size === REQUIRED_CORE_GATES.length),
  }).strict(), centralQualificationSchema]),
}).strict().superRefine((r, ctx) => {
  const p = r.package;
  if (p.file !== `codex-package-${p.target}.tar.gz` ||
      !Object.hasOwn(p.files, "codex-package.json") ||
      !Object.hasOwn(p.files, p.target.includes("windows") ? "bin/codex.exe" : "bin/codex") ||
      new Set(Object.keys(p.files).map(n => n.toLowerCase())).size !== Object.keys(p.files).length)
    ctx.addIssue({ code: "custom", message: "Invalid complete platform payload" });
});
export const channelPayloadSchema = z.object({
  schema: z.enum(["synora.core-channel.v1", "synora.core-channel.v2"]), adapter: z.literal(CORE_CHANNEL_ADAPTER),
  sequence: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(),
  releases: z.array(channelReleaseSchema).max(48),
}).strict().superRefine((p, ctx) => {
  if (p.schema === "synora.core-channel.v1" && p.releases.some(r => "policy" in r.qualification))
    ctx.addIssue({ code: "custom", message: "Central qualification requires the v2 channel" });
  if (p.expiresAt <= p.issuedAt || p.expiresAt - p.issuedAt > MAX_LIFETIME)
    ctx.addIssue({ code: "custom", message: "Invalid catalog lifetime" });
  const ids = p.releases.map(r => `${r.package.target}/${r.package.version}`);
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({ code: "custom", message: "Duplicate Core authorization" });
});
const envelopeSchema = z.object({
  keyId: z.literal(CORE_CHANNEL_KEY_ID),
  payload: z.string().max(MAX_BYTES).regex(/^[A-Za-z0-9+/]+={0,2}$/),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict();
export type CoreChannelPayload = z.infer<typeof channelPayloadSchema>;
export type CoreChannelEnvelope = z.infer<typeof envelopeSchema>;
export function verifyCoreChannel(value: unknown, publicKey = CORE_CHANNEL_PUBLIC_KEY) {
  const envelope = envelopeSchema.parse(value);
  const bytes = Buffer.from(envelope.payload, "base64");
  if (bytes.toString("base64") !== envelope.payload ||
      !verify(null, bytes, publicKey, Buffer.from(envelope.signature, "base64")))
    throw Error("Core channel signature is invalid");
  return { envelope, payload: channelPayloadSchema.parse(JSON.parse(bytes.toString("utf8"))) };
}
export function channelIsFresh(payload: CoreChannelPayload, now: number) {
  return payload.issuedAt <= now + 300000 && payload.expiresAt > now;
}
async function saveJSON(path: string, value: unknown) {
  const tmp = `${path}.${randomUUID()}.tmp`;
  const file = await open(tmp, "wx", 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); }
  finally { await file.close(); }
  try { await rename(tmp, path); } finally { await rm(tmp, { force: true }); }
}
export type CoreChannelOptions = {
  // Constructor-only injection for tests; never exposed through IPC/HTTP.
  fetch?: typeof fetch; publicKey?: string; target?: string; now?: () => number;
};
export class CoreChannel {
  private current?: ReturnType<typeof verifyCoreChannel>;
  private directory: string;
  private target: string;
  private cacheError?: string;
  constructor(root: string, private options: CoreChannelOptions = {}) {
    this.directory = join(root, "runtime-updates", "channel");
    this.target = options.target ?? corePackage().target;
    const path = join(this.directory, "catalog.json");
    if (existsSync(path)) {
      try { this.current = verifyCoreChannel(JSON.parse(readFileSync(path, "utf8")), options.publicKey); }
      catch { this.cacheError = "Saved Core channel signature/metadata is invalid"; }
    }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  candidates(): QualifiedCore[] {
    if (this.cacheError || !this.current || !channelIsFresh(this.current.payload, this.now())) return [];
    return this.current.payload.releases.filter(r => r.package.target === this.target);
  }
  installed(version: string): QualifiedCore {
    compareCoreVersions(version, version); // validate before constructing a path
    const path = join(this.directory, `installed-${this.target}-${version}.json`);
    const { payload } = verifyCoreChannel(JSON.parse(readFileSync(path, "utf8")), this.options.publicKey);
    // Expiry prevents NEW activation, not offline restart/recovery of a binary
    // already authorized. Payload and archive hashes are still checked.
    const release = payload.releases.find(r => r.package.version === version && r.package.target === this.target);
    if (!release) throw Error("Installed Core has no signed authorization");
    return release;
  }
  async retain(version: string) {
    const release = this.candidates().find(r => r.package.version === version);
    if (!release || !this.current) throw Error("Core authorization expired or was withdrawn");
    const path = join(this.directory, `installed-${this.target}-${version}.json`);
    if (existsSync(path) && JSON.stringify(this.installed(version)) !== JSON.stringify(release))
      throw Error("Core channel cannot replace a retained authorization");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await saveJSON(path, this.current.envelope);
  }
  async refresh(signal: AbortSignal) {
    if (this.cacheError) throw Error(this.cacheError); // do not reset replay protection silently
    const response = await (this.options.fetch ?? fetch)(CORE_CHANNEL_URL, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]), redirect: "error", cache: "no-store",
      headers: { Accept: "application/json", "User-Agent": "Synora-Core-Channel" },
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw Error(`Core channel HTTP ${response.status}`);
    }
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.length;
        if (size > MAX_BYTES) throw Error("Core channel exceeds size limit");
        chunks.push(chunk.value);
      }
    } finally { await reader.cancel(); }
    const candidate = verifyCoreChannel(JSON.parse(Buffer.concat(chunks).toString("utf8")), this.options.publicKey);
    if (!channelIsFresh(candidate.payload, this.now())) throw Error("Core channel is expired or from the future");
    if (this.current) {
      const old = this.current.payload.sequence, next = candidate.payload.sequence;
      if (next < old || (next === old && candidate.envelope.payload !== this.current.envelope.payload))
        throw Error("Core channel replay or conflicting sequence rejected");
      // A version is immutable, including its full file inventory and evidence.
      for (const release of candidate.payload.releases) {
        const previous = this.current.payload.releases.find(r => r.package.version === release.package.version && r.package.target === release.package.target);
        if (previous && JSON.stringify(previous) !== JSON.stringify(release))
          throw Error("Core channel attempted to replace an authorized version");
      }
    }
    for (const release of candidate.payload.releases) {
      if (release.package.target !== this.target) continue;
      const path = join(this.directory, `installed-${this.target}-${release.package.version}.json`);
      if (existsSync(path) && JSON.stringify(this.installed(release.package.version)) !== JSON.stringify(release))
        throw Error("Core channel attempted to replace a retained version");
    }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await saveJSON(join(this.directory, "catalog.json"), candidate.envelope);
    this.current = candidate;
    return this.candidates();
  }
}
export const coreEvidenceHash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
