// GitLab's per-platform production manifest is authoritative. No upload API.
const suffixes = {mac:'macos-arm64.zip',win:'windows-x64.exe',linux:'linux-amd64.deb',web:'web-linux-x64.tar.gz'};
try {
  const response = await fetch('/downloads/releases/latest.json', {cache:'no-store',credentials:'omit',signal:AbortSignal.timeout(8000)});
  if (!response.ok) throw new Error('Release manifest unavailable');
  const manifest = await response.json();
  if (manifest.schema !== 1 || !manifest.platforms) throw new Error('Invalid manifest');
  for (const [platform,suffix] of Object.entries(suffixes)) {
    const r = manifest.platforms[platform];
    const card = document.querySelector(`[data-release-platform="${platform}"]`);
    if (!r || !card) continue;
    if (!/^\d+\.\d+\.\d+$/.test(r.version) || !/^[a-f0-9]{64}$/.test(r.sha256) || !/^[a-f0-9]{40}$/.test(r.source) || r.qualification !== 'passed') continue;
    if (!Number.isSafeInteger(r.size) || r.size <= 0 || typeof r.description !== 'string') continue;
    const name = `Synora-${r.version}-${suffix}`;
    const base = `/downloads/releases/${r.version}/`;
    if(r.name!==name || r.url!==base+name || r.notesUrl!==base+`RELEASE-NOTES-${platform}.txt` || r.checksumUrl!==base+`SHA256SUMS-${platform}.txt`)continue;
    const installed = card.dataset.releaseVersion.split('.').map(Number), incoming = r.version.split('.').map(Number);
    const difference = incoming.map((v,i)=>v-installed[i]).find(v=>v!==0)||0;
    if(difference<0)continue;
    card.dataset.releaseVersion=r.version;
    card.querySelector('[data-release-download]').href=r.url;
    card.querySelector('[data-release-version]').textContent=`Version ${r.version} · Build ${r.source.slice(0,7)}`;
    card.querySelector('[data-release-size]').textContent=`${(r.size/1e6).toFixed(1)} MB`;
    card.querySelector('[data-release-description]').textContent=r.description;
    card.querySelector('[data-release-notes]').href=r.notesUrl;
    card.querySelector('[data-release-checksum]').href=r.checksumUrl;
    const counter=card.querySelector('[data-download-asset]');
    if(counter){counter.dataset.downloadRelease=`v${r.version}`;counter.dataset.downloadAsset=name;}
  }
} catch {
  // Exact last-published versioned links remain usable without JS/API/network.
}
await import('./download-counts.js');
