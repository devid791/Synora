// Fixed commands for native runners; no shell/arguments from release metadata.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const mode = process.argv[2];
assert.ok(process.env.CORE_QA_WORKTREE && process.env.SYNORA_CORE_QUALIFICATION_WORKTREE === '1');
process.chdir(process.env.CORE_QA_WORKTREE);
function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: process.env });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} failed (${result.signal ?? result.status})`);
}
const node = (...args) => run(process.execPath, args);
if (mode === 'prepare') {
  assert.match(process.env.CORE_VERSION ?? '', /^\d+\.\d+\.\d+$/);
  if (process.platform === 'win32') run('cmd.exe', ['/d', '/s', '/c', 'npm.cmd ci']);
  else run('npm', ['ci']);
  node('--import', 'tsx', 'scripts/prepare-core-candidate.ts', process.env.CORE_VERSION);
  node('scripts/download-core.mjs');
  node('scripts/prepare-native.mjs');
  node('scripts/brand.mjs');
  node('scripts/build.mjs');
  // afterPack requires a native helper with matching source provenance.
  node('scripts/build-web-mcp.mjs');
} else if (mode === 'package') {
  node('node_modules/electron-builder/cli.js', '--dir', '--publish', 'never',
    '--config.npmRebuild=false', '--config.directories.output=out/core-channel-app');
  const file = process.platform === 'darwin' ? 'mac-arm64/Synora Harness Desktop.app/Contents/MacOS/Synora Harness Desktop' :
    process.platform === 'win32' ? 'win-unpacked/Synora Harness Desktop.exe' : 'linux-unpacked/synora-harness-desktop';
  const executable = resolve('out/core-channel-app', file);
  assert.ok(existsSync(executable), 'Packaged executable missing');
  appendFileSync(process.env.GITHUB_ENV, `SYNORA_TEST_EXECUTABLE=${executable}\n`);
} else if (mode === 'qualify') {
  const args = ['--import', 'tsx', 'scripts/qualify-core-channel.ts'];
  if (process.platform === 'linux') run('xvfb-run', ['-a', '-s', '-screen 0 1600x1100x24 -extension GLX', process.execPath, ...args]);
  else node(...args);
} else throw Error('Unknown native qualification phase');
