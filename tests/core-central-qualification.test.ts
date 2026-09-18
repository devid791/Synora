import test from "node:test";
import assert from "node:assert/strict";
import { centralCoreReportSchema, centrallyQualifiedFromReport } from "../src/engine/core-central-qualification";
import { CENTRAL_CORE_GATES, CENTRAL_CORE_POLICY, CORE_CHANNEL_ADAPTER, channelPayloadSchema } from "../src/engine/core-channel";
import { corePackage } from "../src/engine/core-runtime";

function report() {
  return {schema:"synora.core-central-qualification.v1",adapter:CORE_CHANNEL_ADAPTER,
    sourceCommit:"a".repeat(40),startedAt:Date.now()-1000,completedAt:Date.now(),
    package:corePackage("darwin-arm64"),testedPackage:corePackage("linux-x64"),
    gates:CENTRAL_CORE_GATES.map(gate=>({gate,status:"passed",scope:"server-controlled",passed:1,failed:0,skipped:0,
      artifact:`${gate}.json`,sha256:"b".repeat(64)}))};
}
test("central evidence honestly authorizes a foreign package with mandatory local activation",()=>{
  const release=centrallyQualifiedFromReport(Buffer.from(JSON.stringify(report())));
  assert.ok("policy" in release.qualification);
  assert.equal(release.qualification.policy,CENTRAL_CORE_POLICY);
  assert.equal(release.qualification.testedTarget,"x86_64-unknown-linux-musl");
  assert.equal(release.qualification.localActivation,"required");
  assert.equal(release.package.target,"aarch64-apple-darwin");
  assert.ok(!(release.qualification.checks as string[]).includes("ui"));
  const value={schema:"synora.core-channel.v2",adapter:CORE_CHANNEL_ADAPTER,sequence:1,
    issuedAt:Date.now(),expiresAt:Date.now()+60000,releases:[release]};
  assert.doesNotThrow(()=>channelPayloadSchema.parse(value));
  assert.throws(()=>channelPayloadSchema.parse({...value,schema:"synora.core-channel.v1"}));
  for(const localActivation of [undefined,"optional","passed"])
    assert.throws(()=>channelPayloadSchema.parse({...value,releases:[{...release,qualification:{...release.qualification,localActivation}}]}));
});
for(const name of ["missing","duplicate","failed","skipped","empty","native-claim","wrong-version","wrong-host","stale","future","path"])
  test(`central qualification rejects ${name}`,()=>{
    const r=report();
    if(name==="missing") r.gates.pop();
    if(name==="duplicate") r.gates[1]=r.gates[0];
    if(name==="failed") r.gates[0].failed=1;
    if(name==="skipped") r.gates[0].skipped=1;
    if(name==="empty") r.gates[0].passed=0;
    if(name==="native-claim") r.gates[0].scope="native";
    if(name==="wrong-version") r.testedPackage.version="0.999.0";
    if(name==="wrong-host") r.testedPackage.target="aarch64-apple-darwin";
    if(name==="stale") r.startedAt-=2*86400000;
    if(name==="future") r.completedAt+=3600000;
    if(name==="path") r.gates[0].artifact="../key.json";
    assert.throws(()=>centrallyQualifiedFromReport(Buffer.from(JSON.stringify(r))));
  });
test("Linux publication must be the exact Linux payload tested",()=>{
  const r=report(); r.package=structuredClone(r.testedPackage); r.package.sha256="c".repeat(64);
  assert.throws(()=>centralCoreReportSchema.parse(r));
});
