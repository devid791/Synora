import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { corePackage, installCore, sha256File } from "../src/engine/core-runtime";
import { probeCore } from "../src/engine/core-updater";
import { CORE_CHANNEL_ADAPTER, coreEvidenceHash } from "../src/engine/core-channel";
import { centralCoreReportSchema } from "../src/engine/core-central-qualification";

assert.equal(process.env.SYNORA_CORE_QUALIFICATION_WORKTREE, "1");
assert.equal(process.platform, "linux"); assert.equal(process.arch, "x64");
const platforms: Record<string,string> = {linux: "linux-x64", mac: "darwin-arm64", win: "win32-x64"};
const platform = platforms[process.env.CORE_PLATFORM ?? ""];
assert.ok(platform, "Explicit target required");
const run = promisify(execFile), startedAt = Date.now(), output = resolve("out/core-central");
await mkdir(output, { recursive: true });
const sourceCommit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
const testedPackage = corePackage();
const targetPackage = platform === "linux-x64" ? testedPackage : JSON.parse(await readFile(`out/core-inventory-${platform}.json`, "utf8"));
assert.equal(testedPackage.version, process.env.CORE_VERSION);
assert.equal(targetPackage.version, testedPackage.version);
const executable = await installCore(resolve("out/core-packages", testedPackage.version, testedPackage.file), resolve("out/core-channel-runtime"), testedPackage);
const executableSha256 = await sha256File(executable);
const initialized = await probeCore(executable, testedPackage.version, join(output, "probe-home"));
const gates: any[] = [];
async function evidence(gate: string, artifact: string, value: unknown, passed: number) {
  const bytes = Buffer.from(JSON.stringify(value));
  await writeFile(join(output, artifact), bytes, {flag:"wx"});
  gates.push({gate, artifact, sha256:coreEvidenceHash(bytes), status:"passed", scope:"server-controlled", passed, failed:0, skipped:0});
}
await evidence("official-package", "official-package.json", {
  source: `https://api.github.com/repos/openai/codex/releases/tags/rust-v${testedPackage.version}`,
  targetPackage, testedPackage,
  scope: "Official asset digest, archive and full extracted inventory verified. Foreign binaries NOT executed.",
}, 2);
// Real candidate Core and commands; deterministic loopback Responses, never
// public inference, a personal desktop or an external search dependency.
await run("unshare", ["--user", "--map-root-user", "--net", "sh", "-c",
  'ip link set lo up && exec "$@"', "synora-controlled", process.execPath,
  "node_modules/@playwright/test/cli.js", "test", "--config", "playwright.core-central.config.ts"],
  {timeout:180000, maxBuffer:4*1024*1024});
const raw = JSON.parse(await readFile(join(output,"runtime-raw.json"),"utf8"));
assert.equal(raw.errors?.length ?? 0, 0); assert.ok(raw.stats.expected > 0);
assert.ok(Date.parse(raw.stats.startTime) >= startedAt);
for (const key of ["unexpected","skipped","flaky"]) assert.equal(raw.stats[key],0);
const measured = JSON.parse(await readFile("out/live-evidence/compatible-provider-core.json","utf8"));
assert.equal(measured.passed,true); assert.equal(measured.coreSha256,executableSha256);
assert.deepEqual(measured.errors,[]); assert.ok(measured.cancellation > 0);
await evidence("linux-runtime-contract", "runtime-contract.json", {
  scope:"Actual Linux Core; controlled Responses, not public inference or native Mac/Windows qualification",
  version:testedPackage.version, executableSha256, isolatedHome:initialized.codexHome, raw, measured,
}, raw.stats.expected);
const tests = ["anthropic","compatible","deepseek","gemini","mistral","openai","openrouter","xai"].map(v=>`tests/${v}-provider.test.ts`);
tests.push("tests/mcp-config.test.ts", "tests/mcp-tool-approval.test.ts", "tests/core-compatibility.test.ts");
const result = await run(process.execPath,["--import","tsx","--test","--test-reporter=tap",...tests],{timeout:180000,maxBuffer:8*1024*1024});
const count = (name:string) => Number(new RegExp(`^# ${name} (\\d+)$`,"m").exec(result.stdout)?.[1] ?? NaN);
assert.ok(count("tests") > 0); assert.equal(count("tests"),count("pass"));
for(const name of ["fail","skipped","cancelled","todo"]) assert.equal(count(name),0);
await evidence("provider-contracts", "provider-contracts.json", {scope:"Controlled adapter and MCP unit contracts, not live external services",tap:result.stdout},count("pass"));
const report = centralCoreReportSchema.parse({schema:"synora.core-central-qualification.v1",adapter:CORE_CHANNEL_ADAPTER,
  sourceCommit,startedAt,completedAt:Date.now(),package:targetPackage,testedPackage,gates});
await writeFile(join(output,"qualification.json"),JSON.stringify(report,null,2)+"\n",{flag:"wx"});
console.log(JSON.stringify({version:targetPackage.version,target:targetPackage.target,policy:"server compatibility + mandatory local activation",status:"passed"}));
