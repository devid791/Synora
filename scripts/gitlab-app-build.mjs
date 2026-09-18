// Native, isolated build/QA. Only verified packages become publication artifacts.
import assert from 'node:assert/strict';
import {readFileSync, mkdirSync, copyFileSync, writeFileSync, statSync, createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {suffixes, verifyReport, validateEntry} from './gitlab-app-publish.mjs';
import {transfer} from './gitlab-package-transfer.mjs';
assert.equal(process.env.CI_SERVER_HOST,'gitlab.synapsecorp.org');
assert.equal(process.env.CI_PROJECT_PATH,'davide/synora');
assert.equal(process.env.CI_COMMIT_REF_PROTECTED,'true');
const platform=process.env.APP_PLATFORM;
const expected={mac:['darwin','arm64'],win:['win32','x64'],linux:['linux','x64'],web:['linux','x64']}[platform];
assert.deepEqual([process.platform,process.arch],expected,'Wrong build worker');
const pkg=JSON.parse(readFileSync('package.json','utf8'));
const version=pkg.version;
assert.match(version,/^\d+\.\d+\.\d+$/);
const notes=readFileSync(`releases/${version}.md`,'utf8');
const releases=await fetch('https://synora-ai.org/downloads/releases/latest.json',{cache:'no-store',signal:AbortSignal.timeout(15000)});
assert.ok(releases.ok,'Cannot check already published versions');
const current=(await releases.json()).platforms[platform];
assert.ok(!current||version.localeCompare(current.version,undefined,{numeric:true})>0,
  `Version ${version} is already published for ${platform}; increment package.json/package-lock.json and add release notes before an application change`);
const channel=await fetch('https://synora-ai.org/updates/core/stable-v2.json');
assert.ok(channel.ok,'Core channel unavailable');
// Use the same signed channel validator as clients to choose a native activation test.
const {verifyCoreChannel,channelIsFresh}=await import('../src/engine/core-channel.ts');
const envelope=await channel.json();
const verified=verifyCoreChannel(envelope);
const target={mac:'aarch64-apple-darwin',win:'x86_64-pc-windows-msvc',linux:'x86_64-unknown-linux-musl',web:'x86_64-unknown-linux-musl'}[platform];
assert.ok(channelIsFresh(verified.payload,Date.now()),'Stale Core channel');
const entry=verified.payload.releases.filter(e=>e.package.target===target).sort((a,b)=>a.package.version.localeCompare(b.package.version,undefined,{numeric:true})).at(-1)?.package;
assert.ok(entry,'No qualified Core version for target');
process.env.SYNORA_TEST_CORE_UPDATE_VERSION=entry.version;
function run(command,args) {const r=spawnSync(command,args,{stdio:'inherit',env:process.env});if(r.error)throw r.error;assert.equal(r.status,0,`${command} failed`);}
const node=(...args)=>run(process.execPath,args);
function npm(script) {if(process.platform==='win32')run('cmd.exe',['/d','/s','/c',`npm.cmd run ${script}`]);else run('npm',['run',script]);}
npm('typecheck');
if(process.platform==='linux')run('xvfb-run',['-a','npm','test']);else npm('test');
node('scripts/download-core.mjs');node('scripts/build-web-mcp.mjs');
mkdirSync('out/app-release',{recursive:true});
const name=`Synora-${version}-${suffixes[platform]}`;
const archive=resolve('out/app-release',name);
const evidence=resolve('out/app-release',`${platform}-qualification.json`);
if(platform==='web') {
  npm('package:web');
  copyFileSync(join('out/web-packages',name),archive);
  node('scripts/check-web-package.mjs',archive,evidence);
} else {
  npm('build');
  const args=['node_modules/electron-builder/cli.js','--publish','never','--config.npmRebuild=false'];
  if(platform==='mac') {
    assert.ok(process.env.SYNORA_MAC_SIGN_SCRIPT,'Dedicated Mac runner signing identity is required');
    args.push('--mac','--arm64','--dir',`--config.mac.sign=${process.env.SYNORA_MAC_SIGN_SCRIPT}`);
  } else args.push(platform==='win'?'--win':'--linux',platform==='win'?'nsis':'deb');
  node(...args);
  const folder=resolve('release',platform==='mac'?'mac-arm64/Synora Harness Desktop.app':platform==='win'?'win-unpacked':'linux-unpacked');
  const resources=join(folder,platform==='mac'?'Contents/Resources':'resources');
  node('scripts/check-desktop-package.mjs',process.cwd(),resources,`${process.platform}-${process.arch}`);
  process.env.SYNORA_TEST_EXECUTABLE=join(folder,platform==='mac'?'Contents/MacOS/Synora Harness Desktop':platform==='win'?'Synora Harness Desktop.exe':'synora-harness-desktop');
  const qa=['node_modules/@playwright/test/cli.js','test','--config','playwright.core-startup.config.ts'];
  if(platform==='linux')run('xvfb-run',['-a',process.execPath,...qa]);else node(...qa);
  copyFileSync('test-results/core-startup-update.json',evidence);
  if(platform==='mac') {
    assert.ok(process.env.SYNORA_MAC_SIGN_REQUIREMENT,'Pinned Mac signing requirement missing');
    run('codesign',['--verify','--deep','--strict','-R',process.env.SYNORA_MAC_SIGN_REQUIREMENT,folder]);
    run('ditto',['-c','-k','--sequesterRsrc','--keepParent',folder,archive]);
  } else copyFileSync(platform==='win'?`release/Synora Harness Desktop Setup ${version}.exe`:`release/synora-harness-desktop_${version}_amd64.deb`,archive);
}
verifyReport(JSON.parse(readFileSync(evidence,'utf8')),platform,version);
async function hash(path){const h=createHash('sha256');for await(const b of createReadStream(path))h.update(b);return h.digest('hex');}
const record={platform,version,source:process.env.CI_COMMIT_SHA,name,size:statSync(archive).size,sha256:await hash(archive),evidenceSha256:await hash(evidence),qualification:'passed',description:notes.split('\n').find(line=>line.trim()&&!line.startsWith('#')),notes};
validateEntry(record,platform);
writeFileSync('out/app-release/entry.json',JSON.stringify(record,null,2)+'\n');
const registry=`https://gitlab.synapsecorp.org/api/v4/projects/20/packages/generic/synora-app/${version}`;
await transfer('PUT',`${registry}/${name}`,archive);
await transfer('PUT',`${registry}/${platform}-qualification.json`,evidence);
console.log(`BUILD_AND_NATIVE_QA_PASS ${platform} ${version}`);
