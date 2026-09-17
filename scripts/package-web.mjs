// Native web distribution: compiled UI/server + pinned Core/helper + browser.
// Node >=22.19 is the only language runtime prerequisite; no npm install, compiler,
// Git checkout or automatic code download is needed on the receiving machine.
import { cp, mkdir, readFile, writeFile, lstat, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { packageRuntime } from './package-runtime.mjs';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(project);
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const target = `${process.platform}-${process.arch}`;
assert.ok(['linux-x64', 'darwin-arm64', 'win32-x64'].includes(target));
const name = `Synora-${pkg.version}-web-${target}`;
const destination = resolve('out/web-packages', name);
// Refuse to silently overwrite any previous distribution or receipt.
await mkdir(dirname(destination), { recursive: true });
await mkdir(destination);
for (const file of ['server.mjs', 'ui'])
  await cp(resolve('out/web', file), join(destination, file), { recursive: true, errorOnExist: true });
await cp(resolve('LICENSE'), join(destination, 'LICENSE'));
await cp(resolve('scripts/web-launcher.mjs'), join(destination, 'start.mjs'));
await cp(resolve('docs/WEB-APP.md'), join(destination, 'README.md'));
const copied = new Set();
async function dependency(name) {
  if (copied.has(name)) return;
  assert.match(name, /^(?:@[\w-]+\/)?[\w.-]+$/);
  copied.add(name);
  const source = resolve('node_modules', name);
  assert.ok((await lstat(source)).isDirectory(), `Expected installed dependency ${name}`);
  await cp(source, join(destination, 'node_modules', name), { recursive: true, errorOnExist: true });
  const metadata = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  for (const child of Object.keys(metadata.dependencies ?? {})) await dependency(child);
}
for (const name of ['node-pty', 'playwright-core']) await dependency(name);
await packageRuntime(join(destination, 'resources'), process.platform, process.arch);
// Browser download is build-time only, version pinned by package-lock. Its
// redistributable licenses remain inside the browser payload.
execFileSync(process.execPath, ['node_modules/playwright-core/cli.js', 'install', 'chromium', '--only-shell'], {
  env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: join(destination, 'resources/browser') }, stdio: 'inherit',
});
await writeFile(join(destination, 'start-synora-web.sh'), '#!/bin/sh\nset -eu\ncd -- "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"\nexec node start.mjs\n', { mode: 0o755 });
await writeFile(join(destination, 'start-synora-web.cmd'), '@echo off\r\ncd /d "%~dp0"\r\nnode start.mjs\r\n', { mode: 0o644 });
async function digest(file) {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
}
const entries = [];
async function inventory(dir) {
  for (const name of (await readdir(dir)).sort()) {
    const file = join(dir, name), stat = await lstat(file);
    assert.ok(!stat.isSymbolicLink(), `Unexpected symlink: ${file}`);
    if (stat.isDirectory()) await inventory(file);
    else {
      assert.ok(stat.isFile());
      entries.push({ path: relative(destination, file).replaceAll('\\', '/'), size: stat.size, sha256: await digest(file) });
    }
  }
}
await inventory(destination);
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
await writeFile(join(destination, 'release.json'), JSON.stringify({
  schema: 'synora.web-package.v1', version: pkg.version, target, sourceCommit,
  nodeMinimum: '22.19.0', core: JSON.parse(await readFile('docs/core-runtime-lock.json', 'utf8')).version, entries,
}, null, 2) + '\n');
const archive = destination + '.tar.gz';
execFileSync('tar', ['-czf', archive, '-C', dirname(destination), name], { stdio: 'inherit' });
await writeFile(archive + '.sha256', `${await digest(archive)}  ${name}.tar.gz\n`);
console.log(JSON.stringify({ directory: destination, archive, version: pkg.version, target, files: entries.length }));
