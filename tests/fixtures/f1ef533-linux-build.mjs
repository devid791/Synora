// Private exact-source build/qualification. No install, model call or service change.
import { spawn, execFileSync } from 'node:child_process';
import { openSync, closeSync } from 'node:fs';
import { readFile, writeFile, mkdtemp, stat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const project = '/home/synora/Synora_Harness_Desktop';
const commit = 'f1ef533fcceb24dc882edc2d96a9bcfc73a2f6c4';
const receiptHash = 'fede0e3567a806410e3400a5b088d5812e4816b1ea853ee765801af4afa12a2b';
const hash = (b) => createHash('sha256').update(b).digest('hex');
if (process.platform !== 'linux' || process.cwd() !== project || process.getuid() !== 1000)
  throw Error('Exact owned Linux project/user required');
const source = () => {
  const value = JSON.parse(execFileSync(process.execPath, ['scripts/source-receipt.mjs', 'verify', 'out/compiled-source-receipt.json'], { encoding: 'utf8' }));
  if (value.commit !== commit || value.files !== 1186 || value.mismatches.length) throw Error('Source differs from frozen candidate');
  return value;
};
if (hash(await readFile('out/compiled-source-receipt.json')) !== receiptHash) throw Error('Wrong compiled-source receipt');
const before = source();
const root = '/run/user/1000';
const rootStat = await stat(root);
if (rootStat.uid !== 1000 || (rootStat.mode & 0o077) ||
    execFileSync('findmnt', ['-n', '-T', root, '-o', 'FSTYPE'], { encoding: 'utf8' }).trim() !== 'tmpfs')
  throw Error('Private RAM-backed temporary storage required');
const temporary = await mkdtemp(root + '/synora-f1ef533-linux-');
const output = temporary + '/package';
const evidence = await mkdtemp('out/live-evidence/f1ef533-linux-build-');
const env = { ...process.env };
for (const key of Object.keys(env)) if (key.startsWith('SYNORA_')) delete env[key];
Object.assign(env, { TMPDIR: temporary, PLAYWRIGHT_BROWSERS_PATH: project + '/.cache/browsers' });
const receipt = { started: new Date().toISOString(), commit, sourceBefore: before, temporary, output, evidence,
  archivedPrevious: 'out/qualification-archives/2026-09-10T04-50-52-114Z-rFjBKH',
  installed: false, published: false, modelRequests: 0, steps: [], passed: false };
const save = () => writeFile(evidence + '/receipt.json', JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
await save();
console.log(JSON.stringify({ temporary, output, evidence }));
async function run(name, command, args, variables = {}) {
  const step = { name, command, args, started: new Date().toISOString() };
  receipt.steps.push(step); await save();
  const fd = openSync(evidence + '/' + name + '.log', 'wx', 0o600);
  const child = spawn(command, args, { env: { ...env, ...variables }, stdio: ['ignore', fd, fd] });
  step.pid = child.pid;
  const result = await new Promise((done, fail) => { child.once('error', fail); child.once('exit', (code, signal) => done({ code, signal })); }).finally(() => closeSync(fd));
  Object.assign(step, result, { finished: new Date().toISOString() }); await save();
  console.log(JSON.stringify(step));
  if (result.code !== 0) throw Error('Failed ' + name + '; preserve logs and inspect before continuing');
  return step;
}
async function test(name, config, reportName, count, native = true) {
  const args = [process.execPath, 'node_modules/@playwright/test/cli.js', 'test', '--workers=1', '--retries=0', '--config', config];
  const step = await run(name, native ? 'xvfb-run' : args.shift(), native ? ['-a', '-s', '-screen 0 1800x1200x24 -extension GLX', ...args] : args,
    native ? { SYNORA_TEST_EXECUTABLE: receipt.executable } : {});
  const reportPath = 'test-results/' + reportName + '.json';
  const bytes = await readFile(reportPath), report = JSON.parse(bytes);
  if ((await stat(reportPath)).mtimeMs < Date.parse(step.started) || report.errors.length ||
      report.stats.expected !== count || report.stats.unexpected || report.stats.skipped || report.stats.flaky ||
      (native && (report.config.metadata.asar_sha256 !== receipt.asarSha256 || resolve(report.config.metadata.executable) !== receipt.executable)))
    throw Error('Report identity/results not qualified: ' + name);
  step.report = { path: reportPath, sha256: hash(bytes), stats: report.stats };
  await writeFile(evidence + '/' + name + '.json', bytes, { flag: 'wx', mode: 0o600 }); await save();
}
try {
  const tests = (await readdir('tests')).filter((p) => p.endsWith('.test.ts')).sort().map((p) => 'tests/' + p);
  await run('local', process.execPath, ['node_modules/tsx/dist/cli.mjs', '--test', ...tests, 'tests/native-preparation.test.mjs']);
  const tap = await readFile(evidence + '/local.log', 'utf8');
  if (!/^# tests 368$/m.test(tap) || !/^# pass 368$/m.test(tap) || !/^# fail 0$/m.test(tap) || !/^# skipped 0$/m.test(tap) || !/^# cancelled 0$/m.test(tap))
    throw Error('Full local suite did not pass all 368 cases');
  await run('package-linux', 'npm', ['run', 'package:linux', '--', '--config.directories.output=' + output, '--publish', 'never']);
  receipt.executable = output + '/linux-unpacked/synora-harness-desktop';
  receipt.executableSha256 = hash(await readFile(receipt.executable));
  receipt.asarSha256 = hash(await readFile(output + '/linux-unpacked/resources/app.asar'));
  receipt.deb = output + '/synora-harness-desktop_0.1.0-foundation.2_amd64.deb';
  receipt.debSha256 = hash(await readFile(receipt.deb));
  receipt.debBytes = (await stat(receipt.deb)).size;
  receipt.sourceAfterBuild = source(); await save();
  await run('build-web', 'npm', ['run', 'build:web']);
  receipt.sourceAfterWeb = source(); await save();
  await test('native-base', 'playwright.config.ts', 'desktop', 2);
  await test('native-quality', 'playwright.quality-desktop.config.ts', 'ui-quality-desktop', 1);
  await test('native-updater', 'playwright.core-update-desktop.config.ts', 'core-update-native', 1);
  await test('native-bearer', 'playwright.provider-native.config.ts', 'provider-native', 1);
  await test('web-base', 'playwright.web.config.ts', 'web', 2, false);
  await test('web-quality', 'playwright.quality.config.ts', 'ui-quality-web', 4, false);
  receipt.sourceAfter = source();
  receipt.passed = true;
} catch (error) {
  receipt.error = String(error); process.exitCode = 1;
} finally {
  receipt.finished = new Date().toISOString(); await save();
  console.log(JSON.stringify({ evidence, passed: receipt.passed, error: receipt.error, output }));
}
