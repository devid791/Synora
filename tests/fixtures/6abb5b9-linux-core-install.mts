// Private one-shot qualification of the changed installer with the pinned full
// archive. Not a packaged UI/inference/provider test; no global installation.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, statfs, lstat, realpath } from 'node:fs/promises';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { corePackage, installCore, verifyCoreArchive, verifyCoreInstall, sha256File } from '../../src/engine/core-runtime';

assert.equal(process.cwd(),'/home/synora/Synora_Harness_Desktop');
assert.equal(process.platform,'linux');
const source=await sha256File('src/engine/core-runtime.ts');
assert.equal(source,'876c9aeef6c00524e88a557fcab5497ca205fb4c4e5c173ab59943304f9a5d26');
const spec=corePackage(), archive=resolve('out/core-packages',spec.file);
await verifyCoreArchive(archive,spec);
const capacity=await statfs(tmpdir());
assert.ok(capacity.bavail*capacity.bsize>600_000_000,'Need full-payload plus safe remaining disk margin');
const evidence=await mkdtemp('out/live-evidence/fresh-core-6abb5b9-');
const directory=await mkdtemp(join(tmpdir(),'synora-6abb-full-core-'));
const cache=join(directory,'cache');
const receipt:any={scope:'Full original archive/source installer and --version only; not UI/inference or public upgrade',started:new Date().toISOString(),sourceCommit:'6abb5b9339e51898846d86e3bf62fb43d6d65a7d',sourceSha256:source,archive,archiveSha256:await sha256File(archive),directory,cache,availableBefore:capacity.bavail*capacity.bsize,passed:false,temporaryPayloadRemoved:false};
try {
  const started=performance.now();
  const executable=await installCore(archive,cache,spec);
  receipt.installMs=performance.now()-started;
  const installed=dirname(dirname(executable));
  assert.equal(dirname(installed),cache);
  assert.equal(await verifyCoreInstall(installed,spec),executable);
  const result=await promisify(execFile)(executable,['--version'],{timeout:10000,maxBuffer:65536});
  assert.match(result.stdout,/0\.153\.4/);
  receipt.executable=executable;
  receipt.executableSha256=await sha256File(executable);
  receipt.version={stdout:result.stdout,stderr:result.stderr};
  receipt.installedFiles=await readdir(installed);
  assert.equal(await sha256File('src/engine/core-runtime.ts'),source);
  // Delete only our newly created, independently verified derived cache. Keep
  // all reports, input archives, the shared donor and any failed stage intact.
  assert.equal(await realpath(directory),directory);
  assert.equal((await lstat(directory)).uid,process.getuid!());
  assert.deepEqual(await readdir(directory),['cache']);
  assert.deepEqual(await readdir(cache),[installed.slice(cache.length+1)]);
  await rm(directory,{recursive:true});
  receipt.temporaryPayloadRemoved=true;
  receipt.passed=true;
} catch(error) {
  receipt.error=String(error);
  receipt.failedDirectoryPreserved=true;
  process.exitCode=1;
} finally {
  const after=await statfs(tmpdir());
  receipt.availableAfter=after.bavail*after.bsize;
  receipt.finished=new Date().toISOString();
  await writeFile(join(evidence,'receipt.json'),JSON.stringify(receipt,null,2)+'\n',{flag:'wx',mode:0o600});
  console.log(JSON.stringify({evidence,...receipt}));
}
