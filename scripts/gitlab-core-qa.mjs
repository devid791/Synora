import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtempSync, mkdirSync, cpSync, existsSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';

assert.equal(process.env.CI_SERVER_HOST, 'gitlab.synapsecorp.org');
assert.equal(process.env.CI_PROJECT_PATH, 'davide/synora');
assert.equal(process.env.CI_COMMIT_REF_PROTECTED, 'true');
assert.match(process.env.CI_JOB_ID ?? '', /^\d+$/);
const expected = {linux: ['linux','x64'], mac: ['darwin','arm64'], win: ['win32','x64']}[process.env.CORE_PLATFORM];
assert.deepEqual([process.platform, process.arch], expected, 'Wrong native worker');
const root = process.cwd(), temporary = mkdtempSync(join(tmpdir(), 'synora-gitlab-core-'));
const checkout = join(temporary, 'source'), artifacts = resolve('out/gitlab-core');
const env = {...process.env, RUNNER_TEMP: temporary, CORE_QA_WORKTREE: checkout, SYNORA_CORE_QUALIFICATION_WORKTREE: '1'};
// No ambient Actions environment or installed production application is used.
delete env.GITHUB_ENV;
let status = 1, added = false;
try {
  execFileSync('git', ['worktree','add','--detach',checkout,process.env.CI_COMMIT_SHA], {stdio:'inherit'});
  added = true;
  for (const mode of ['prepare','package','qualify']) {
    if (mode === 'qualify') {
      const file = process.platform === 'darwin' ? 'mac-arm64/Synora Harness Desktop.app/Contents/MacOS/Synora Harness Desktop' :
        process.platform === 'win32' ? 'win-unpacked/Synora Harness Desktop.exe' : 'linux-unpacked/synora-harness-desktop';
      env.SYNORA_TEST_EXECUTABLE = join(checkout, 'out/core-channel-app', file);
    }
    const result = spawnSync(process.execPath, [join(root,'scripts/run-core-channel-job.mjs'),mode], {env,stdio:'inherit'});
    if(result.error) throw result.error;
    if(result.status !== 0) throw Error(`Native ${mode} failed (${result.signal ?? result.status})`);
  }
  status = 0;
} catch(error) {
  console.error(error.message);
} finally {
  mkdirSync(artifacts, {recursive:true});
  // Private, expiring GitLab artifacts retain the failed step and Playwright trace.
  // Never collect Core homes, profile databases, environment files or credentials.
  for(const relative of ['out/core-channel-qualification','test-results']) {
    const source = join(checkout,relative);
    if(existsSync(source)) cpSync(source, join(artifacts,relative), {recursive:true,
      filter: path => !path.includes('probe-home') && !path.includes('.codex')});
  }
  if(added) execFileSync('git',['worktree','remove','--force',checkout],{stdio:'inherit'});
  rmSync(temporary,{recursive:true,force:true}); // this process's mkdtemp only
}
process.exitCode=status;
