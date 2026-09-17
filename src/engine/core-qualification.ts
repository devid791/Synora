import { z } from "zod";
import { channelReleaseSchema, CORE_CHANNEL_ADAPTER, coreEvidenceHash } from "./core-channel";
import { REQUIRED_CORE_GATES } from "./qualified-core";
import { PROTOCOL_VERSION } from "../shared/contracts";

// Reports must come from trusted isolated QA runners. This validates measured
// results; the signing job never accepts a release note or boolean "approved".
export const coreGateSchema = z.object({
  gate: z.enum(REQUIRED_CORE_GATES),
  status: z.literal("passed"),
  scope: z.enum(["native", "live", "controlled"]),
  passed: z.number().int().positive(), failed: z.literal(0), skipped: z.literal(0),
  artifact: z.string().regex(/^[a-zA-Z0-9_.-]+\.json$/),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export const coreQualificationSchema = z.object({
  schema: z.literal("synora.core-qualification.v1"), adapter: z.literal(CORE_CHANNEL_ADAPTER),
  sourceCommit: z.string().regex(/^[a-f0-9]{40}$/),
  startedAt: z.number().int().positive(), completedAt: z.number().int().positive(),
  package: channelReleaseSchema.innerType().shape.package,
  gates: z.array(coreGateSchema).length(REQUIRED_CORE_GATES.length),
}).strict().superRefine((r, ctx) => {
  if (r.completedAt < r.startedAt || new Set(r.gates.map(g => g.gate)).size !== REQUIRED_CORE_GATES.length)
    ctx.addIssue({ code: "custom", message: "Incomplete qualification" });
  for (const g of r.gates) {
    if ((g.gate === "axiom-turn" && g.scope !== "live") ||
        (["initialize", "native-sandbox", "ui"].includes(g.gate) && g.scope !== "native"))
      ctx.addIssue({ code: "custom", message: `Insufficient evidence scope: ${g.gate}` });
  }
});
export function qualifiedFromReport(bytes: Uint8Array, now = Date.now()) {
  const report = coreQualificationSchema.parse(JSON.parse(Buffer.from(bytes).toString("utf8")));
  if (report.completedAt > now + 300000 || report.startedAt < now - 24 * 3600000)
    throw Error("Qualification report is stale or from the future");
  return channelReleaseSchema.parse({
    package: report.package, protocol: PROTOCOL_VERSION,
    qualification: { sourceCommit: report.sourceCommit, evidenceSha256: coreEvidenceHash(bytes), checks: report.gates.map(g => g.gate) },
  });
}
