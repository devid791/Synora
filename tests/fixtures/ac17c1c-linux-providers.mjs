// Exact-candidate QA only. Controlled peers inside a loopback-only namespace;
// no public inference, GPU use, installation or production configuration.
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, stat, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const project = '/home/synora/Synora_Harness_Desktop';
const executable = project + '/out/production-qa-linux-ac17c1c/linux-unpacked/synora-harness-desktop';
const asar = project + '/out/production-qa-linux-ac17c1c/linux-unpacked/resources/app.asar';
const pins = [
  [executable, '9578f5ece2da6cbba4b5d0fb7e7adaaf8f07d44684bddfdab92024c84d80d2f3'],
  [asar, 'd2e54672a5cdfdafc1c16c31917b30b890e9b712179398426aab71d87c370759'],
];
if (process.platform !== 'linux' || process.cwd() !== project || process.getuid() !== 1000)
  throw Error('Exact owned Linux QA host/user/project required');
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function verify() {
  for (const [path, hash] of pins)
    if (digest(await readFile(path)) !== hash) throw Error('Candidate changed: ' + path);
  const source = JSON.parse(execFileSync(process.execPath,
    ['scripts/source-receipt.mjs', 'verify', 'out/compiled-source-receipt.json'], { encoding: 'utf8' }));
  if (source.commit !== 'ac17c1c3183b88a5721778f751a3410010f56259' || source.mismatches.length)
    throw Error('Compiled application source mismatch');
  return source;
}
const source = await verify();
const runtime = '/run/user/1000';
const runtimeStat = await stat(runtime);
if (runtimeStat.uid !== 1000 || (runtimeStat.mode & 0o077)) throw Error('Private runtime directory required');
const filesystem = execFileSync('findmnt', ['-n', '-T', runtime, '-o', 'FSTYPE'], { encoding: 'utf8' }).trim();
if (filesystem !== 'tmpfs') throw Error('RAM-backed private QA state required');
const temporary = await mkdtemp(runtime + '/synora-ac17-providers-');
const output = await mkdtemp('out/live-evidence/ac17-linux-providers-');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('SYNORA_')) delete env[key];
Object.assign(env, {
  SYNORA_TEST_EXECUTABLE: executable,
  SYNORA_CORE_CACHE: '/tmp/synora-openai-provider-WLOk5u/payload/core-runtime',
  PLAYWRIGHT_BROWSERS_PATH: project + '/.cache/browsers',
  TMPDIR: temporary,
});
const cases = [
  ['openai', 'playwright.openai-provider-desktop.config.ts', 'openai-provider-native'],
  ['xai', 'playwright.xai-desktop.config.ts', 'xai-provider-native'],
  ['openrouter', 'playwright.openrouter-desktop.config.ts', 'openrouter-desktop'],
  ['anthropic', 'playwright.anthropic-desktop.config.ts', 'anthropic-desktop'],
  ['gemini', 'playwright.gemini-desktop.config.ts', 'gemini-desktop'],
  ['deepseek', 'playwright.deepseek-desktop.config.ts', 'deepseek-desktop'],
  ['mistral', 'playwright.mistral-desktop.config.ts', 'mistral-desktop'],
  ['compatible', 'playwright.compatible-desktop.config.ts', 'compatible-desktop'],
];
const receipt = {
  at: new Date().toISOString(), source, executable, asar: pins[1][1], temporary,
  output, scope: 'Original Core, real local tools, controlled provider peers; no public account or model inference',
  archive: 'out/qualification-archives/2026-09-10T04-08-59-058Z-9ZDEW1',
  cases: [], passed: false,
};
// Each script runs the unchanged tests. They independently require that the
// actual interfaces consist only of lo before creating the controlled peer.
const shell = 'ip link set lo up && exec setpriv --inh-caps=-all --ambient-caps=-all xvfb-run -a -s "-screen 0 1800x1200x24 -extension GLX" "$@"';
console.log(JSON.stringify({ output, temporary, cases: cases.length }));
const save = () => writeFile(output + '/receipt.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
await save();
try {
  for (const [name, config, reportName] of cases) {
    const startedAt = new Date().toISOString();
    const fd = openSync(output + '/' + name + '.log', 'wx', 0o600);
    const child = spawn('unshare', [
      '--user', '--map-current-user', '--keep-caps', '--net', '--', 'sh', '-c', shell, 'synora-provider-qa',
      process.execPath, 'node_modules/@playwright/test/cli.js', 'test', '--workers=1', '--retries=0', '--config', config,
    ], { env, stdio: ['ignore', fd, fd] });
    const exit = await new Promise((done, fail) => {
      child.once('error', fail);
      child.once('exit', (code, signal) => done({ code, signal }));
    }).finally(() => closeSync(fd));
    const file = 'test-results/' + reportName + '.json';
    const bytes = await readFile(file), report = JSON.parse(bytes);
    const modified = await stat(file);
    if (modified.mtimeMs < Date.parse(startedAt)) throw Error('Stale report: ' + file);
    const passed = exit.code === 0 && report.errors.length === 0 && report.stats.expected === 1 &&
      !report.stats.unexpected && !report.stats.skipped && !report.stats.flaky &&
      report.config.metadata.asar_sha256 === pins[1][1] && resolve(report.config.metadata.executable) === executable;
    const entry = { name, config, startedAt, finishedAt: new Date().toISOString(), pid: child.pid,
      exit, report: file, sha256: digest(bytes), stats: report.stats, passed };
    receipt.cases.push(entry);
    await writeFile(output + '/' + name + '.json', bytes, { flag: 'wx', mode: 0o600 });
    await save();
    console.log(JSON.stringify(entry));
    if (!passed) throw Error('Failed ' + name + '; no automatic retry or next case');
  }
  receipt.sourceAfter = await verify();
  receipt.temporaryDirectories = await readdir(temporary);
  receipt.passed = true;
} catch (error) {
  receipt.error = String(error);
  process.exitCode = 1;
} finally {
  receipt.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ output, passed: receipt.passed, error: receipt.error }));
}
