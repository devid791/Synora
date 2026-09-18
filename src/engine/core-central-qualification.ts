import { z } from "zod";
import { CENTRAL_CORE_GATES, CENTRAL_CORE_POLICY, CORE_CHANNEL_ADAPTER, channelReleaseSchema, coreEvidenceHash } from "./core-channel";
import { PROTOCOL_VERSION } from "../shared/contracts";

// Deliberately different from native app qualification. It never certifies UI,
// OS grants, public inference or native Windows/macOS execution on Linux.
export const centralCoreReportSchema = z.object({
  schema: z.literal("synora.core-central-qualification.v1"),
  adapter: z.literal(CORE_CHANNEL_ADAPTER),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  startedAt: z.number().int().positive(), completedAt: z.number().int().positive(),
  package: channelReleaseSchema.innerType().shape.package,
  testedPackage: channelReleaseSchema.innerType().shape.package,
  gates: z.array(z.object({
    gate: z.enum(CENTRAL_CORE_GATES), status: z.literal("passed"),
    scope: z.literal("server-controlled"),
    passed: z.number().int().positive(), failed: z.literal(0), skipped: z.literal(0),
    artifact: z.string().regex(/^[a-zA-Z0-9_.-]+\.json$/),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict()).length(CENTRAL_CORE_GATES.length),
}).strict().superRefine((r, ctx) => {
  if (r.testedPackage.target !== "x86_64-unknown-linux-musl" ||
      r.testedPackage.version !== r.package.version ||
      r.completedAt < r.startedAt ||
      new Set(r.gates.map(g => g.gate)).size !== CENTRAL_CORE_GATES.length)
    ctx.addIssue({ code: "custom", message: "Incomplete or mismatched central qualification" });
  if (r.package.target === r.testedPackage.target && JSON.stringify(r.package) !== JSON.stringify(r.testedPackage))
    ctx.addIssue({ code: "custom", message: "Tested Linux payload differs from published payload" });
});

export function centrallyQualifiedFromReport(bytes: Uint8Array, now = Date.now()) {
  const r = centralCoreReportSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (r.completedAt > now + 300000 || r.startedAt < now - 24 * 3600000)
    throw Error("Central qualification is stale or from the future");
  return channelReleaseSchema.parse({ package: r.package, protocol: PROTOCOL_VERSION,
    qualification: { policy: CENTRAL_CORE_POLICY, testedTarget: r.testedPackage.target,
      localActivation: "required", sourceCommit: r.sourceCommit,
      evidenceSha256: coreEvidenceHash(bytes), checks: r.gates.map(g => g.gate) } });
}
