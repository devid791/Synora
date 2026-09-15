// Build-time only. No unattended update, global installation or API account.
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,stat,rename,rm,open} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {join,resolve} from 'node:path';
import lock from '../docs/core-runtime-lock.json' with {type:'json'};
import legacy from '../docs/core-runtime-legacy.json' with {type:'json'};
const destination=resolve('out/core-packages');await mkdir(destination,{recursive:true});
async function digest(path){const sha=createHash('sha256');for await(const c of createReadStream(path))sha.update(c);return sha.digest('hex');}
async function download(platform,pins) {
  const target=pins.targets[platform];if(!target)throw new Error(`Unsupported Core platform: ${platform}`);
  const directory=pins.version===legacy.version?destination:join(destination,pins.version);
  await mkdir(directory,{recursive:true});
  const path=join(directory,target.file);
  try{await stat(path);if(await digest(path)!==target.sha256)throw new Error(`Existing archive hash mismatch: ${target.file}`);console.log(`${platform}: pinned Core archive verified`);return;}catch(e){if(e.code!=='ENOENT')throw e;}
  const response=await fetch(`https://github.com/openai/codex/releases/download/rust-v${pins.version}/${target.file}`,{signal:AbortSignal.timeout(240000)});
  if(!response.ok||!response.body)throw new Error(`Core download failed: HTTP ${response.status}`);
  const temporary=join(destination,`${randomUUID()}.partial`);const file=await open(temporary,'wx',0o600);
  let bytes=0;const sha=createHash('sha256');
  try {
    for await(const chunk of response.body){bytes+=chunk.length;if(bytes>target.size)throw new Error('Core archive exceeds its pinned size');sha.update(chunk);await file.writeFile(chunk);}
    if(bytes!==target.size||sha.digest('hex')!==target.sha256)throw new Error('Core archive size/SHA256 does not match the official lock');
    await file.sync();await file.close();await rename(temporary,path);console.log(`${platform}: Core ${pins.version} downloaded and SHA256 verified`);
  }catch(e){await file.close();await rm(temporary,{force:true});throw e;}
}
await Promise.all((process.argv.slice(2).length?process.argv.slice(2):[`${process.platform}-${process.arch}`]).flatMap(platform=>[download(platform,lock),download(platform,legacy)]));
