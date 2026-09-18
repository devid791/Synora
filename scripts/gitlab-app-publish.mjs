import assert from 'node:assert/strict';
import {createReadStream, createWriteStream} from 'node:fs';
import {readFile, writeFile, mkdir, mkdtemp, rm, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn, execFileSync} from 'node:child_process';
import {pipeline} from 'node:stream/promises';
import {Readable} from 'node:stream';
import {transfer} from './gitlab-package-transfer.mjs';

export const suffixes={mac:'macos-arm64.zip',win:'windows-x64.exe',linux:'linux-amd64.deb',web:'web-linux-x64.tar.gz'};
export function validateEntry(entry, platform) {
  assert.ok(Object.hasOwn(suffixes,platform));
  assert.equal(entry.platform,platform);
  assert.match(entry.version,/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  assert.equal(entry.name,`Synora-${entry.version}-${suffixes[platform]}`);
  assert.match(entry.source,/^[a-f0-9]{40}$/);
  assert.match(entry.sha256,/^[a-f0-9]{64}$/);
  assert.ok(Number.isSafeInteger(entry.size)&&entry.size>0&&entry.size<=2*1024**3);
  assert.match(entry.evidenceSha256,/^[a-f0-9]{64}$/);
  assert.equal(typeof entry.notes,'string'); assert.ok(entry.notes.length>0&&entry.notes.length<=20000);
  assert.equal(typeof entry.description,'string'); assert.ok(entry.description.length>0&&entry.description.length<=1000);
  assert.equal(entry.qualification,'passed');
}
export function verifyReport(report, platform, version) {
  if(platform==='web') {
    assert.equal(report.version,version); assert.equal(report.status,'PASS');
    assert.ok(report.manifestFiles>0); assert.ok(report.checks.length>=6);
  } else {
    assert.ok(report.stats.expected>0);
    for(const field of ['unexpected','skipped','flaky']) assert.equal(report.stats[field],0);
    assert.deepEqual(report.errors,[]);
  }
}
async function hash(path) { const h=createHash('sha256'); for await(const b of createReadStream(path))h.update(b);return h.digest('hex'); }
async function run() {
  assert.equal(process.env.CI_SERVER_HOST,'gitlab.synapsecorp.org');
  assert.equal(process.env.CI_PROJECT_PATH,'davide/synora');
  assert.equal(process.env.CI_COMMIT_REF_PROTECTED,'true');
  assert.match(process.env.CI_PIPELINE_ID,/^\d+$/);
  const platform=process.env.APP_PLATFORM;
  const local=process.env.APP_BUILD==='1';
  const entry=local?JSON.parse(await readFile('out/app-release/entry.json','utf8')):
    JSON.parse(await readFile('releases/app-stable.json','utf8')).platforms[platform];
  validateEntry(entry,platform);
  // The approved source must exist in this repository. No arbitrary remote payload.
  execFileSync('git',['cat-file','-e',entry.source+'^{commit}']);
  const directory=await mkdtemp(join(tmpdir(),'synora-app-publish-'));
  try {
    const registry=`https://gitlab.synapsecorp.org/api/v4/projects/20/packages/generic/synora-app/${entry.version}`;
    for(const [name,expected] of [[entry.name,entry.sha256],[`${platform}-qualification.json`,entry.evidenceSha256]]) {
      const target=join(directory,name);
      await transfer('GET',`${registry}/${name}`,target);
      assert.equal(await hash(target),expected,`${name}: SHA256 mismatch`);
    }
    assert.equal((await stat(join(directory,entry.name))).size,entry.size);
    verifyReport(JSON.parse(await readFile(join(directory,`${platform}-qualification.json`),'utf8')),platform,entry.version);
    console.log(`QUALIFIED ${platform} ${entry.version}: native/package evidence and exact archive verified`);
    const key=join(directory,'key'), hosts=join(directory,'known-hosts');
    for(const name of ['SYNORA_APP_DEPLOY_KEY','SYNORA_APP_KNOWN_HOSTS'])assert.ok(process.env[name],`Missing protected ${name}`);
    await writeFile(key,process.env.SYNORA_APP_DEPLOY_KEY,{mode:0o600});
    await writeFile(hosts,process.env.SYNORA_APP_KNOWN_HOSTS,{mode:0o600});
    const options=['-i',key,'-o',`UserKnownHostsFile=${hosts}`,'-o','StrictHostKeyChecking=yes','-o','BatchMode=yes','-o','ConnectTimeout=15','synora-release-publish@46.254.38.135'];
    async function ssh(command, input) {
      const p=spawn('ssh',[...options,command],{stdio:['pipe','inherit','inherit'],timeout:900000});
      const done=new Promise((resolve,reject)=>{p.once('error',reject);p.once('close',code=>code===0?resolve():reject(Error(`Restricted publisher failed (${code})`)));});
      await Promise.all([pipeline(input,p.stdin),done]);
    }
    await ssh(`upload ${platform} ${entry.version} ${entry.size} ${entry.sha256}`,createReadStream(join(directory,entry.name)));
    await ssh('publish',Readable.from([JSON.stringify({...entry,pipeline:process.env.CI_PIPELINE_ID})]));
    // Check public metadata and the actual direct download, not a GitHub redirect.
    const base='https://synora-ai.org/downloads/releases/';
    const r=await fetch(base+'latest.json?pipeline='+process.env.CI_PIPELINE_ID,{signal:AbortSignal.timeout(30000)});
    assert.ok(r.ok); const published=(await r.json()).platforms[platform];
    assert.equal(published.sha256,entry.sha256);assert.equal(published.version,entry.version);
    const head=await fetch(new URL(published.url,'https://synora-ai.org'),{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(30000)});
    assert.equal(head.status,200);assert.equal(Number(head.headers.get('content-length')),entry.size);
    await mkdir('out/app-publication',{recursive:true});
    await writeFile(`out/app-publication/${platform}.json`,JSON.stringify({status:'PASS',platform,version:entry.version,sha256:entry.sha256,url:new URL(published.url,'https://synora-ai.org').href,pipeline:process.env.CI_PIPELINE_ID},null,2));
    console.log(`PUBLIC PASS ${platform} ${entry.version}: ${published.url}`);
  } finally {await rm(directory,{recursive:true,force:true});}
}
if(process.argv[1]?.endsWith('/gitlab-app-publish.mjs')||process.argv[1]?.endsWith('\\gitlab-app-publish.mjs')) await run();
