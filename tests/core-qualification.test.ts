import test from "node:test";
import assert from "node:assert/strict";
import { coreQualificationSchema, qualifiedFromReport } from "../src/engine/core-qualification";
import { CORE_CHANNEL_ADAPTER } from "../src/engine/core-channel";
import { corePackage } from "../src/engine/core-runtime";
import { REQUIRED_CORE_GATES } from "../src/engine/qualified-core";
function report() {
  return { schema: "synora.core-qualification.v1", adapter: CORE_CHANNEL_ADAPTER,
    sourceCommit: "a".repeat(40), startedAt: Date.now() - 10000, completedAt: Date.now(), package: structuredClone(corePackage()),
    gates: REQUIRED_CORE_GATES.map(gate => ({ gate, status: "passed", scope: gate === "axiom-turn" ? "live" : "native",
      passed: 1, failed: 0, skipped: 0, artifact: `${gate}.json`, sha256: "b".repeat(64) })) };
}
test("only complete, fresh, measured qualification can authorize a release", () => {
  const result = qualifiedFromReport(Buffer.from(JSON.stringify(report())));
  assert.equal(result.package.version, corePackage().version);
  assert.deepEqual(result.qualification.checks, [...REQUIRED_CORE_GATES]);
});
for (const change of ["skipped", "failed", "empty", "duplicate", "simulated-live", "stale"])
  test(`qualification rejects ${change} rather than publishing a false pass`, () => {
    const r = report();
    if (change === "skipped") r.gates[0].skipped = 1;
    if (change === "failed") r.gates[0].failed = 1;
    if (change === "empty") r.gates[0].passed = 0;
    if (change === "duplicate") r.gates[1] = r.gates[0];
    if (change === "simulated-live") r.gates.find(g => g.gate === "axiom-turn")!.scope = "controlled";
    if (change === "stale") r.startedAt -= 2 * 86400000;
    assert.throws(() => qualifiedFromReport(Buffer.from(JSON.stringify(r))));
  });
test("report paths cannot escape the qualification artifact directory", () => {
  const r = report(); r.gates[0].artifact = "../../private.json";
  assert.throws(() => coreQualificationSchema.parse(r));
});
