import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { corePackage, installCore, sha256File } from "../src/engine/core-runtime";
import { probeCore } from "../src/engine/core-updater";
import { CORE_CHANNEL_ADAPTER, coreEvidenceHash } from "../src/engine/core-channel";
import { coreQualificationSchema } from "../src/engine/core-qualification";

// Runs on dedicated native interactive QA workers, never in user profiles.
// Missing OS grants/backend/search/desktop => failed job, never PASS or skipped.
assert.equal(process.env.SYNORA_CORE_QUALIFICATION_WORKTREE, "1");
for (const key of ["SYNORA_TEST_EXECUTABLE", "SYNORA_TEST_ENDPOINT", "SYNORA_TEST_SEARCH_URL"])
  assert.ok(process.env[key], `${key} must be configured on the dedicated QA runner`);
if (process.platform === "win32") assert.ok(process.env.SYNORA_TEST_PREPARED_WINDOWS_QA,
  "Windows requires a pre-provisioned, runner-owned interactive sandbox; no unattended UAC bypass");
const run = promisify(execFile), startedAt = Date.now();
const sourceCommit = (await run("git", ["rev-parse", "HEAD"])).stdout.trim();
const spec = corePackage(), candidate = JSON.parse(await readFile("out/core-channel-candidate.json", "utf8"));
assert.deepEqual(candidate, spec, "Candidate pin must match the app build");
const output = resolve("out/core-channel-qualification"); await mkdir(output, { recursive: true });
const resources = resolve(dirname(process.env.SYNORA_TEST_EXECUTABLE!), process.platform === "darwin" ? "../Resources" : "resources");
// afterPack verifies this archive; verify the tested package once more here.
assert.equal(await sha256File(join(resources, "core-packages", spec.version, spec.file)), spec.sha256);
const executable = await installCore(resolve("out/core-packages", spec.version, spec.file), resolve("out/core-channel-runtime"), spec);
const env: NodeJS.ProcessEnv = { ...process.env, SYNORA_QUALIFY_CORE_VERSION: spec.version };
const gates: any[] = [];
async function evidence(name: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value)); const artifact = `${name}.json`;
  await writeFile(join(output, artifact), bytes, { flag: "wx" });
  return { artifact, sha256: coreEvidenceHash(bytes) };
}
const initialized = await probeCore(executable, spec.version, join(output, "probe-home"));
gates.push({ gate: "initialize", status: "passed", scope: "native", passed: 1, failed: 0, skipped: 0,
  ...await evidence("initialize", { version: spec.version, executableSha256: await sha256File(executable), isolatedHome: initialized.codexHome }) });
async function playwright(config: string, name: string, covered: string[], scope: "native" | "live") {
  const reportPath = join(output, `${name}-raw.json`);
  await run(process.execPath, ["node_modules/@playwright/test/cli.js", "test", "--config", config,
    "--reporter=json", "--workers=1", "--retries=0"], {
    env: { ...env, PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath }, timeout: 20 * 60 * 1000, maxBuffer: 4 * 1024 * 1024,
  });
  const bytes = await readFile(reportPath), report = JSON.parse(bytes.toString());
  assert.ok(Date.parse(report.stats.startTime) >= startedAt, "Stale Playwright report");
  assert.equal(report.errors?.length ?? 0, 0); assert.ok(report.stats.expected > 0);
  for (const key of ["unexpected", "skipped", "flaky"]) assert.equal(report.stats[key], 0, `${name}: ${key}`);
  assert.equal(resolve(report.config.metadata.executable), resolve(env.SYNORA_TEST_EXECUTABLE!));
  assert.equal(report.config.metadata.asar_sha256, await sha256File(join(resources, "app.asar")));
  for (const gate of covered) gates.push({ gate, status: "passed", scope: gate === "native-sandbox" ? "native" : scope,
    passed: report.stats.expected, failed: 0, skipped: 0, artifact: `${name}-raw.json`, sha256: coreEvidenceHash(bytes) });
}
await playwright("playwright.live-desktop.config.ts", "live", ["axiom-turn", "tools", "sse", "resume", "native-sandbox"], "live");
await playwright(process.platform === "win32" ? "playwright.cancel-windows.config.ts" : "playwright.cancel-desktop.config.ts", "cancel", ["cancel"], "live");
await playwright("playwright.live-mcp-desktop.config.ts", "mcp", ["plugins-mcp"], "live");
await playwright("playwright.core-update-desktop.config.ts", "ui", ["ui"], "native");
const providerTests = ["anthropic", "compatible", "deepseek", "gemini", "mistral", "openai", "openrouter", "xai"].map(v => `tests/${v}-provider.test.ts`);
const tested = await run(process.execPath, ["--import", "tsx", "--test", "--test-reporter=tap", ...providerTests], { env, timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
const count = (name: string) => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(tested.stdout)?.[1] ?? NaN);
assert.ok(count("tests") > 0); assert.equal(count("tests"), count("pass"));
for (const field of ["fail", "skipped", "cancelled", "todo"]) assert.equal(count(field), 0);
gates.push({ gate: "provider-adapters", status: "passed", scope: "controlled", passed: count("pass"), failed: 0, skipped: 0,
  ...await evidence("provider-adapters", { scope: "Controlled provider adapter contract tests, not public third-party model inference", tap: tested.stdout }) });
const report = coreQualificationSchema.parse({ schema: "synora.core-qualification.v1", adapter: CORE_CHANNEL_ADAPTER,
  sourceCommit, startedAt, completedAt: Date.now(), package: spec, gates });
await writeFile(join(output, "qualification.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
console.log(JSON.stringify({ version: spec.version, platform: spec.target, gates: gates.length, status: "passed" }));
