import test from "node:test";
import assert from "node:assert/strict";
import { nativeCredentialCipher } from "../src/main/native-credential-cipher";

for (const platform of ['win32'] as const) {
  test(`${platform}: constructing the credential adapter never opens the OS store; actual operations remain encrypted`,()=>{
    const calls:string[]=[];let enabled=true;
    const sealed=Buffer.from('unchanged-existing-OS-envelope');
    const cipher=nativeCredentialCipher({
      isEncryptionAvailable(){calls.push('available');return enabled;},
      getSelectedStorageBackend(){throw Error('Not Linux');},
      encryptString(value){calls.push('seal');assert.equal(value,'QA_PRIVATE');return sealed;},
      decryptString(value){calls.push('open');assert.equal(value,sealed);return 'QA_PRIVATE';},
    },platform)!;
    assert.deepEqual(calls,[]);
    assert.equal(cipher.seal('QA_PRIVATE'),sealed);assert.equal(cipher.open(sealed),'QA_PRIVATE');
    assert.deepEqual(calls,['available','seal','available','open']);
    enabled=false;
    assert.throws(()=>cipher.seal('QA_PRIVATE'),/unavailable/);
    assert.throws(()=>cipher.open(sealed),/unavailable/);
    assert.deepEqual(calls.slice(-2),['available','available']);
  });
}
const blockingForbidden = {
  isEncryptionAvailable(): boolean { throw Error('Blocking availability must never run on macOS'); },
  getSelectedStorageBackend(): 'unknown' { throw Error('Not Linux'); },
  encryptString(): Buffer { throw Error('Blocking encryption must never run on macOS'); },
  decryptString(): string { throw Error('Blocking decryption must never run on macOS'); },
};
test('macOS: lazy async access shares initialization and preserves encrypted bytes and rotation hints without rewriting',async()=>{
  const calls:string[]=[];
  const encrypted=Buffer.from('legacy-os-envelope');
  const cipher=nativeCredentialCipher({...blockingForbidden,
    async isAsyncEncryptionAvailable(){calls.push('available');return true;},
    async encryptStringAsync(value){calls.push('seal');assert.equal(value,'QA_PRIVATE');return encrypted;},
    async decryptStringAsync(value){calls.push('open');assert.equal(value,encrypted);return {result:'QA_PRIVATE',shouldReEncrypt:true};},
  },'darwin')!;
  assert.deepEqual(calls,[]);
  const results=await Promise.all([cipher.seal('QA_PRIVATE'),cipher.open(encrypted)]);
  assert.equal(results[0],encrypted);assert.equal(results[1],'QA_PRIVATE');
  assert.deepEqual(calls,['available','seal','open']);
  assert.equal(await cipher.open(encrypted),'QA_PRIVATE');
  assert.deepEqual(calls,['available','seal','open','open']);
});
for(const ready of ['false','reject','missing'] as const)test(`macOS ${ready}: no blocking fallback or repeated OS initialization`,async()=>{
  let attempts=0;
  const storage={...blockingForbidden,...(ready==='missing'?{}:{
    async isAsyncEncryptionAvailable(){attempts++;if(ready==='reject')throw Error('OS denied');return false;},
    async encryptStringAsync(){throw Error('Must not encrypt');},
    async decryptStringAsync(){throw Error('Must not decrypt');},
  })};
  const cipher=nativeCredentialCipher(storage,'darwin')!;
  await assert.rejects(async()=>cipher.seal('QA'),/unavailable/);
  await assert.rejects(async()=>cipher.open(Buffer.from('legacy')),/unavailable/);
  assert.equal(attempts,ready==='missing'?0:1);
});
test('macOS: a pending OS prompt does not freeze the event loop or create a retry storm; late grant recovers',async()=>{
  let resolveReady!:(v:boolean)=>void,attempts=0;
  const ready=new Promise<boolean>(resolve=>{resolveReady=resolve;});
  const encrypted=Buffer.from('encrypted');
  const cipher=nativeCredentialCipher({...blockingForbidden,
    isAsyncEncryptionAvailable(){attempts++;return ready;},
    async encryptStringAsync(){return encrypted;},
    async decryptStringAsync(){return {result:'QA',shouldReEncrypt:false};},
  },'darwin',{timeoutMs:25})!;
  const pending=cipher.seal('QA');
  const rejected=assert.rejects(async()=>pending,/unavailable/);
  let ticked=false;await new Promise<void>(resolve=>setTimeout(()=>{ticked=true;resolve();},0));
  assert.equal(ticked,true);
  await rejected;
  for(let i=0;i<5;i++)await assert.rejects(async()=>cipher.open(encrypted),/unavailable/);
  assert.equal(attempts,1);
  resolveReady(true);await new Promise<void>(resolve=>setImmediate(resolve));
  assert.equal(await cipher.open(encrypted),'QA');assert.equal(attempts,1);
});
test('macOS: actual asynchronous operations are bounded and do not select a plaintext fallback',async()=>{
 const cipher=nativeCredentialCipher({...blockingForbidden,
  async isAsyncEncryptionAvailable(){return true;},
  encryptStringAsync(){return new Promise<Buffer>(()=>{});},
  decryptStringAsync(){return new Promise<{result:string;shouldReEncrypt:boolean}>(()=>{});},
 },'darwin',{timeoutMs:15})!;
 await Promise.all([
  assert.rejects(async()=>cipher.seal('QA'),/unavailable/),
  assert.rejects(async()=>cipher.open(Buffer.from('legacy')),/unavailable/),
 ]);
});
test('macOS: timed-out callers never overlap an unfinished OS operation or execute a late queued request',async()=>{
 let finish!:(v:Buffer)=>void,seals=0,opens=0;
 const cipher=nativeCredentialCipher({...blockingForbidden,
  async isAsyncEncryptionAvailable(){return true;},
  encryptStringAsync(){seals++;return new Promise<Buffer>(resolve=>{finish=resolve;});},
  async decryptStringAsync(){opens++;return {result:'QA',shouldReEncrypt:false};},
 },'darwin',{timeoutMs:15})!;
 await Promise.all([
  assert.rejects(async()=>cipher.seal('QA'),/unavailable/),
  assert.rejects(async()=>cipher.open(Buffer.from('legacy')),/unavailable/),
 ]);
 assert.equal(seals,1);assert.equal(opens,0);
 await assert.rejects(async()=>cipher.open(Buffer.from('legacy')),/unavailable/);
 assert.equal(opens,0);
 finish(Buffer.from('encrypted'));await new Promise<void>(resolve=>setImmediate(resolve));
 assert.equal(opens,0); // Expired callers never resume their deferred OS action.
 assert.equal(await cipher.open(Buffer.from('legacy')),'QA');assert.equal(opens,1);
});
test('Linux preserves the selected secure-backend policy; no basic_text is treated as encrypted',()=>{
 for(const available of [false,true])for(const backend of ['gnome_libsecret','kwallet','kwallet5','kwallet6','basic_text','unknown'] as const){
  const cipher=nativeCredentialCipher({isEncryptionAvailable:()=>available,getSelectedStorageBackend:()=>backend,encryptString:()=>{throw Error('Not invoked');},decryptString:()=>{throw Error('Not invoked');}},'linux');
  assert.equal(!!cipher,available&&!['basic_text','unknown'].includes(backend));
 }
});
