import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {readFile,lstat,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {gunzipSync} from 'node:zlib';
import assert from 'node:assert/strict';
const [sourceArg,resourcesArg,key]=process.argv.slice(2);
const source=resolve(sourceArg),resources=resolve(resourcesArg);
const require=createRequire(join(source,'package.json')),asar=require('@electron/asar');
const sha=b=>createHash('sha256').update(b).digest('hex');
const lock=JSON.parse(await readFile(join(source,'docs/core-runtime-lock.json'),'utf8'));
const legacy=JSON.parse(await readFile(join(source,'docs/core-runtime-legacy.json'),'utf8'));
const appFile=join(resources,'app.asar'),entries=asar.listPackage(appFile);
const pkg=JSON.parse(asar.extractFile(appFile,'package.json'));
assert.equal(pkg.version,JSON.parse(await readFile(join(source,'package.json'),'utf8')).version);
assert.deepEqual(entries.filter(p=>/(^|[\\/])(?:\.git|\.ssh|\.codex|provider-credentials|core-homes|qa-reports|state\.sqlite|gpu-collectors\.json|\.env)([\\/]|$)/.test(p)),[]);
assert(entries.some(p=>p.replaceAll('\\','/').endsWith('/dist/main.cjs')));
assert(!((await readdir(resources)).some(p=>/^source-|qa-|private-|\.env|\.git$/.test(p))));
const archives=[];
for(const [version,spec,dir] of [[lock.version,lock.targets[key],lock.version],[legacy.version,legacy.targets[key],'']]){
 const path=join(resources,'core-packages',dir,spec.file),s=await lstat(path);assert(s.isFile()&&!s.isSymbolicLink());
 assert.equal(s.size,spec.size);const h=sha(await readFile(path));assert.equal(h,spec.sha256);archives.push({version,sha256:h});
}
for(const file of ['LICENSE.txt','NOTICE.txt'])assert.equal(sha(await readFile(join(resources,'core-packages',file))),sha(await readFile(join(source,'native/licenses/core',file))));
const helper=JSON.parse(await readFile(join(resources,'native',key,'web-mcp-manifest.json'),'utf8'));
for(const [file,expected] of Object.entries(helper.source_hashes))assert.equal(sha(await readFile(join(source,file))),expected);
const helperName=key.startsWith('win32')?'synora-web-mcp.exe':'synora-web-mcp';
assert.equal(sha(gunzipSync(await readFile(join(resources,'native',key,helperName+'.gz')))),helper.sha256);
assert(asar.extractFile(appFile,'dist/main.cjs').includes(Buffer.from('/ops/hardware')));
assert(asar.extractFile(appFile,'dist/main.cjs').includes(Buffer.from('serverTimeAtObservation')));
assert(asar.extractFile(appFile,'dist/main.cjs').includes(Buffer.from('https://synora-ai.org/updates/core/stable-v2.json')));
for(const file of entries.map(p=>p.replaceAll('\\','/').replace(/^\//,''))
 .filter(p=>p.startsWith('dist/') && /\.(?:cjs|js|css|html)$/.test(p)))
 assert.equal(sha(asar.extractFile(appFile,join(...file.split('/')))),sha(await readFile(join(source,file))),`Packaged code differs: ${file}`);
console.log(JSON.stringify({status:'PASS',platform:key,version:pkg.version,asarSha256:sha(await readFile(appFile)),archives,privateDataPathsAbsent:true,nativeSourceProvenance:true,coreLicenses:true},null,2));
