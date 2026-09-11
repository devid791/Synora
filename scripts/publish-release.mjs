import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Original, unchanged baseline 67eed3d packages. This publishes no build and
// does not promote the known cross-platform limitations to production GO.
const repository = 'devid791/Synora';
const tag = 'v0.1.0-foundation.2';
const origin = 'https://synora-ai.org/downloads/';
const assets = [
  { name: 'Synora-67eed3d-macos-arm64.zip', size: 250790917, sha256: 'dadb88946bfce491a8055512b6ff30ee98bece0a6f59e1b4c84dff0585b957ac', type: 'application/zip' },
  { name: 'Synora-67eed3d-linux-amd64.deb', size: 231983880, sha256: 'c799d0635775f1349c8982a88b0dfb1c250477c672efbe34f1766644c9311fda', type: 'application/octet-stream' },
  { name: 'Synora-67eed3d-windows-x64.exe', size: 259036023, sha256: '8987c221bdf33dea4c2354aba44da6282546ca50df1a934f98b434ae1cea3b18', type: 'application/octet-stream' },
  { name: 'SHA256SUMS.txt', size: 291, sha256: '72c61a64ceb73f0157400dcd669f42427714e08d6cf89126eca2b8d71acc1737', type: 'text/plain' },
  { name: 'RELEASE-NOTES.txt', size: 2676, sha256: 'de199ea13e66d39d71e2ba6b86fd4db1e485bbb0ebc4773148d4bf544fefc763', type: 'text/plain' },
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
    origin + asset.name,
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
  assert.ok([`refs/tags/${tag}`, 'refs/heads/main'].includes(process.env.GITHUB_REF));
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
  // A publication retry from main uses the existing, immutable release tag.
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
  const body = `## Synora desktop preview\n\nOriginal baseline **67eed3d** packages, unchanged. This is a preview, not a blanket production qualification.\n\n- **macOS Apple silicon:** download the ARM64 ZIP (macOS 13+). Locally signed, not Apple-notarized.\n- **Windows x64:** download the EXE installer (unsigned).\n- **Linux AMD64:** download the DEB package.\n\nUse the installer assets below, not GitHub's automatically generated source archives. Compare file hashes with **SHA256SUMS.txt**.\n\n[Searchable manual](https://synora-ai.org/manual/) · [Website downloads](https://synora-ai.org/#downloads) · [Report a bug](https://github.com/devid791/Synora/issues)\n\n### Release notes and limitations\n\n\`\`\`text\n${notes.trim()}\n\`\`\`\n`;
  if (!release) release = await api('releases', { method: 'POST', body: JSON.stringify({
    tag_name: tag, name: 'Synora 0.1.0 Foundation 2 — desktop preview', body,
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
