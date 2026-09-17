import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Publish the exact tested hardware-discovery packages, without rebuilding or changing them.
// Qualification scope and local signing/OS grant limitations remain explicit.
const repository = 'devid791/Synora';
const tag = 'v0.2.1';
const origin = 'https://synora-ai.org/downloads/';
const assets = [
  { name: 'Synora-0.2.1-macos-arm64.zip', size: 364032862, sha256: '05a551be0b398407daedcef8108c75b9391f3e55f124e1bea4fb351b78ff6e53', type: 'application/zip' },
  { name: 'Synora-0.2.1-windows-x64.exe', size: 395353148, sha256: '679c6c27b7e8f2e4477bf4aa21c4ee41e68c8eb6e3987729f0b2ab61b2e8b08e', type: 'application/octet-stream' },
  { name: 'Synora-0.2.1-linux-amd64.deb', size: 357583824, sha256: '8864dfdd0bf988beb79dfd73c59906b142397b026c40482c77d714aa35973500', type: 'application/octet-stream' },
  { name: 'SHA256SUMS.txt', source: 'SHA256SUMS-0.2.1.txt', size: 285, sha256: '778d51e6294e81e4371bac4ae684b303295ed855cf7f31a006a4d650a1942c7d', type: 'text/plain' },
  { name: 'RELEASE-NOTES.txt', source: 'RELEASE-NOTES-0.2.1.txt', size: 3373, sha256: 'cc9a1dd92ade3b3ca96b85238aaa2c95cc6e8951558f3a0096e5d4d1915f45ec', type: 'text/plain' },
];

async function verifyFile(directory, asset) {
  const path = join(directory, asset.name);
  assert.equal((await stat(path)).size, asset.size, `${asset.name}: size mismatch`);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  assert.equal(hash.digest('hex'), asset.sha256, `${asset.name}: SHA256 mismatch`);
  console.log(`Verified ${asset.name}`);
}

async function download(directory, asset) {
  // GitHub runners are challenged by the public CDN's bot protection. Read the
  // same publicly downloadable files at the fixed HTTPS hosting origin, keeping
  // TLS certificate/hostname validation and all site read-only rules intact.
  // This is the public website host, never a model endpoint or private service.
  await promisify(execFile)('curl', [
    '--fail', '--silent', '--show-error', '--proto', '=https', '--tlsv1.2',
    '--resolve', 'synora-ai.org:443:46.254.38.135', '--max-time', '600',
    '--max-filesize', String(asset.size), '--output', join(directory, asset.name),
    origin + (asset.source ?? asset.name),
  ], { env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, maxBuffer: 8192 });
  await verifyFile(directory, asset);
}

function validateAssets(uploaded) {
  assert.equal(uploaded.length, assets.length, 'Release must contain exactly the five expected assets');
  for (const expected of assets) {
    const asset = uploaded.find(item => item.name === expected.name);
    assert.ok(asset, `${expected.name}: missing release asset`);
    assert.equal(asset.state, 'uploaded', `${expected.name}: upload incomplete`);
    assert.equal(asset.size, expected.size, `${expected.name}: GitHub size mismatch`);
    assert.equal(asset.digest, `sha256:${expected.sha256}`, `${expected.name}: GitHub SHA256 mismatch`);
  }
}

async function main() {
  if (process.argv[2] === '--verify-local') {
    assert.ok(process.argv[3], 'Expected package directory');
    for (const asset of assets) await verifyFile(process.argv[3], asset);
    return;
  }
  assert.equal(process.env.GITHUB_REPOSITORY, repository);
  assert.ok([`refs/tags/${tag}`, 'refs/heads/codex/release-v0.2.1'].includes(process.env.GITHUB_REF));
  assert.ok(process.env.GH_TOKEN, 'GitHub Actions token required');
  const authorization = `Bearer ${process.env.GH_TOKEN}`;
  async function api(path, options = {}) {
    const url = new URL(path, `https://api.github.com/repos/${repository}/`);
    assert.equal(url.origin, 'https://api.github.com');
    assert.ok(url.pathname.startsWith(`/repos/${repository}/`));
    const response = await fetch(url, {
      ...options,
      redirect: 'error',
      headers: { authorization, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'X-GitHub-Api-Version': '2026-03-10' },
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`GitHub API ${options.method || 'GET'} ${url.pathname}: HTTP ${response.status}`);
    return response.json();
  }
  // A publication retry uses the existing, immutable release tag.
  // Never create a tag implicitly from whichever branch happened to trigger it.
  await api(`git/ref/tags/${tag}`);
  const releases = await api('releases?per_page=100');
  let release = releases.find(item => item.tag_name === tag);
  if (release && !release.draft) {
    validateAssets(await api(`releases/${release.id}/assets?per_page=100`));
    console.log(`Already published and verified: ${release.html_url}`);
    return;
  }

  const directory = await mkdtemp(join(tmpdir(), 'synora-release-'));
  // Validate every byte before creating or modifying a release.
  for (const asset of assets) await download(directory, asset);
  const notes = await readFile(join(directory, 'RELEASE-NOTES.txt'), 'utf8');
  const body = `## Synora 0.2.1 — automatic hardware discovery preview\n\nDiscover server GPUs and physical memory pools through your selected Axiom provider, with explicit execution-device reporting. The live browser remains beside your conversation. Exact tested **bd1717a** application packages, with Codex App Server **0.154.0**. This remains a preview with the qualification scope below.\n\n- **macOS Apple silicon:** download the ARM64 ZIP (macOS 13+). Locally signed, not Apple-notarized; local Keychain approval may be required after updating. No Apple account is needed for local operation.\n- **Windows x64:** download the EXE installer (unsigned).\n- **Linux AMD64:** download the DEB package.\n\nUse the installer assets below, not GitHub's automatically generated source archives. Compare file hashes with **SHA256SUMS.txt**.\n\n[Searchable manual](https://synora-ai.org/manual/) · [Website downloads](https://synora-ai.org/#downloads) · [Report a bug](https://github.com/devid791/Synora/issues)\n\n### Release notes and limitations\n\n\`\`\`text\n${notes.trim()}\n\`\`\`\n`;
  if (!release) release = await api('releases', { method: 'POST', body: JSON.stringify({
    tag_name: tag, name: 'Synora 0.2.1 — automatic hardware discovery preview', body,
    draft: true, prerelease: true, make_latest: 'false',
  }) });
  else await api(`releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ body, prerelease: true }) });

  const uploaded = await api(`releases/${release.id}/assets?per_page=100`);
  for (const asset of assets) {
    const existing = uploaded.find(item => item.name === asset.name);
    if (existing) {
      assert.equal(existing.state, 'uploaded', `${asset.name}: previous upload incomplete; inspect the draft before retrying`);
      assert.equal(existing.digest, `sha256:${asset.sha256}`, `${asset.name}: existing asset differs; refusing overwrite`);
      assert.equal(existing.size, asset.size);
      continue;
    }
    const url = new URL(release.upload_url.replace(/\{.*$/, ''));
    assert.equal(url.origin, 'https://uploads.github.com');
    assert.ok(url.pathname.startsWith(`/repos/${repository}/releases/`));
    url.searchParams.set('name', asset.name);
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', duplex: 'half',
      headers: { authorization, 'content-type': asset.type, 'content-length': String(asset.size), 'X-GitHub-Api-Version': '2026-03-10' },
      body: createReadStream(join(directory, asset.name)), signal: AbortSignal.timeout(600_000),
    });
    if (!response.ok) throw new Error(`${asset.name}: upload HTTP ${response.status}; release remains draft`);
    const result = await response.json();
    assert.equal(result.digest, `sha256:${asset.sha256}`);
    assert.equal(result.size, asset.size);
    console.log(`Uploaded and verified ${asset.name}`);
  }
  validateAssets(await api(`releases/${release.id}/assets?per_page=100`));
  const published = await api(`releases/${release.id}`, { method: 'PATCH', body: JSON.stringify({ draft: false, prerelease: true, make_latest: 'false' }) });
  console.log(`Published complete preview: ${published.html_url}`);
}

await main().catch(error => {
  // Emit only the controlled diagnostic, never request headers or credentials.
  const message = String(error?.message ?? 'Release publication failed').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`::error title=Release verification::${message}`);
  process.exitCode = 1;
});
