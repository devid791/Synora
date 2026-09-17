import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Publish the exact tested aligned packages, without rebuilding or changing them.
// Qualification scope and local signing/OS grant limitations remain explicit.
const repository = 'devid791/Synora';
const tag = 'v0.2.3';
const origin = 'https://synora-ai.org/downloads/0.2.3/';
const assets = [
  { name: 'Synora-0.2.3-macos-arm64.zip', size: 364037900, sha256: 'c023ceee1a1d2675ab5211aa536a42d983f63cce22a78a9146e00e06e443992c', type: 'application/zip' },
  { name: 'Synora-0.2.3-windows-x64.exe', size: 395356727, sha256: '00e1f86eee788ff8799f0f4c5a476b3314ff9350ec812588086586397ee8cda5', type: 'application/octet-stream' },
  { name: 'Synora-0.2.3-linux-amd64.deb', size: 357588448, sha256: 'c217bc1cfb159f8d2aaaa1e1311a806e50f65b4491fd6ec77ae6bdd0ddef748e', type: 'application/octet-stream' },
  { name: 'Synora-0.2.3-web-linux-x64.tar.gz', size: 385739076, sha256: '8e044a1078bb6ec71227a8a9079d51b9f1cc7f2fb336245a616a1589e80359f1', type: 'application/gzip' },
  { name: 'SHA256SUMS.txt', size: 385, sha256: '2cc28c65cc9f2cc043663c35e2fb4379ddd8df32ce6759d04bfa6f2e9b1e63e8', type: 'text/plain' },
  { name: 'RELEASE-NOTES.txt', size: 3916, sha256: '4563f1525f5b11bfd67409b1569537d23bcfeef938ba317b973b57bf7778b988', type: 'text/plain' },
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
  assert.equal(uploaded.length, assets.length, 'Release must contain exactly the six expected assets');
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
  assert.ok([`refs/tags/${tag}`, 'refs/heads/codex/release-v0.2.3'].includes(process.env.GITHUB_REF));
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
  const body = `## Synora 0.2.3 — aligned desktop and web preview\n\nAdds the local web distribution, signed Core updates, and reliable foreground/background connection ownership. The live browser remains beside your conversation. Exact tested **a054117** application packages, with Codex App Server **0.154.0**. This remains a preview with the qualification scope below.\n\n- **macOS Apple silicon:** download the ARM64 ZIP (macOS 13+). Locally signed, not Apple-notarized; local Keychain approval may be required after updating. No Apple account is needed for local operation.\n- **Windows x64:** download the EXE installer (unsigned).\n- **Linux AMD64:** download the DEB package.\n\nUse the installer assets below, not GitHub's automatically generated source archives. Compare file hashes with **SHA256SUMS.txt**.\n\n[Searchable manual](https://synora-ai.org/manual/) · [Website downloads](https://synora-ai.org/#downloads) · [Report a bug](https://github.com/devid791/Synora/issues)\n\n### Release notes and limitations\n\n\`\`\`text\n${notes.trim()}\n\`\`\`\n`;
  if (!release) release = await api('releases', { method: 'POST', body: JSON.stringify({
    tag_name: tag, name: 'Synora 0.2.3 — aligned desktop and web preview', body,
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
