import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
assert.ok(process.env.RUNNER_TEMP && process.env.GITHUB_ENV && /^\d+$/.test(process.env.GITHUB_RUN_ID ?? ''));
const directory = join(process.env.RUNNER_TEMP, `synora-core-${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT}`);
assert.match(process.env.GITHUB_RUN_ATTEMPT ?? '', /^\d+$/);
if (process.argv[2] === 'cleanup') {
  assert.equal(resolve(process.env.CORE_QA_WORKTREE ?? ''), resolve(directory));
  execFileSync('git', ['worktree', 'remove', '--force', directory], { stdio: 'inherit' });
  process.exit(0);
}
execFileSync('git', ['worktree', 'add', '--detach', directory, 'HEAD'], { stdio: 'inherit' });
appendFileSync(process.env.GITHUB_ENV, `CORE_QA_WORKTREE=${directory}\nSYNORA_CORE_QUALIFICATION_WORKTREE=1\n`);
