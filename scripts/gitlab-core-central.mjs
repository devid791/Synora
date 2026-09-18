import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, cpSync, existsSync, rmSync, realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
assert.equal(process.env.CI_SERVER_HOST,'gitlab.synapsecorp.org');
assert.equal(process.env.CI_PROJECT_PATH,'davide/synora');
assert.equal(process.env.CI_COMMIT_REF_PROTECTED,'true');
assert.match(process.env.CI_COMMIT_SHA ?? '',/^[a-f0-9]{40}$/);
assert.equal(process.platform,'linux'); assert.equal(process.arch,'x64');
const platform = {linux:'linux-x64',mac:'darwin-arm64',win:'win32-x64'}[process.env.CORE_PLATFORM];
assert.ok(platform);
const temporary=mkdtempSync(join(realpathSync.native(tmpdir()),'synora-central-'));
const checkout=join(temporary,'source'), artifacts=resolve('out/gitlab-core');
const env={...process.env,RUNNER_TEMP:temporary,SYNORA_CORE_QUALIFICATION_WORKTREE:'1'};
delete env.GITHUB_ENV;
let added=false;
function run(command,args) {
  const result=spawnSync(command,args,{cwd:checkout,env,stdio:'inherit'});
  if(result.error) throw result.error;
  assert.equal(result.status,0,`${command} failed (${result.signal ?? result.status})`);
}
try {
  execFileSync('git',['worktree','add','--detach',checkout,process.env.CI_COMMIT_SHA],{stdio:'inherit'}); added=true;
  run('npm',['ci','--ignore-scripts']);
  run(process.execPath,['--import','tsx','scripts/prepare-core-candidate.ts',process.env.CORE_VERSION]);
  if(platform!=='linux-x64') run(process.execPath,['--import','tsx','scripts/prepare-core-candidate.ts',process.env.CORE_VERSION,'--inventory-only',platform]);
  run(process.execPath,['--import','tsx','scripts/qualify-core-central.ts']);
} catch(error) { console.error(error.message); process.exitCode=1; }
finally {
  mkdirSync(artifacts,{recursive:true});
  for(const relative of ['out/core-central','out/live-evidence']) {
    if(existsSync(join(checkout,relative))) cpSync(join(checkout,relative),join(artifacts,relative),{recursive:true,
      filter:path=>!path.includes('probe-home') && !path.includes('.codex')});
  }
  if(added) execFileSync('git',['worktree','remove','--force',checkout],{stdio:'inherit'});
  rmSync(temporary,{recursive:true,force:true});
}
