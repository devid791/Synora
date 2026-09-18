import assert from 'node:assert/strict';
import {writeFileSync} from 'node:fs';
const response = await fetch('https://api.github.com/repos/openai/codex/releases/latest', {
  redirect: 'error', signal: AbortSignal.timeout(30000), headers: {Accept: 'application/vnd.github+json'},
});
assert.ok(response.ok, `Official release discovery HTTP ${response.status}`);
const release = await response.json();
assert.equal(release.draft, false); assert.equal(release.prerelease, false);
assert.match(release.tag_name, /^rust-v\d+\.\d+\.\d+$/);
writeFileSync('core-candidate.env', `CORE_VERSION=${release.tag_name.slice(6)}\n`, {flag: 'wx'});
console.log(`Stable Core candidate: ${release.tag_name.slice(6)}`);
