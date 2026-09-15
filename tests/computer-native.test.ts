import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import {nativeInspection} from "../src/main/native-inspection";

// Controlled process-dispatch regression; the packaged executor is separately
// exercised with real SendInput on Windows' non-admin interactive desktop.
test("Windows input uses the stock PS5-compatible executor and private stdin, without policy overrides",async()=>{
 const code=ts.transpileModule(readFileSync(new URL('../src/main/computer-native.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
 const calls:{file:string,args:string[],options:any,input?:string}[]=[];
 const output:any={};const require=createRequire(import.meta.url);
 runInNewContext(code,{exports:output,__dirname:'/qa',process:{platform:'win32'},Buffer,setTimeout,clearTimeout,Error,
  require(id:string){
   if(id==='./native-inspection')return {nativeInspection};
   if(id==='electron')return {desktopCapturer:{getSources:async()=>[{id:'window:42:0',name:'Harbour QA Desk'}]}};
   if(id==='node:child_process')return {spawn(file:string,args:string[],options:any){
    const call={file,args,options,input:undefined as string|undefined};calls.push(call);
    const child:any=new EventEmitter();child.stdout=new EventEmitter();child.stderr={resume(){}};child.kill=()=>{};
    child.stdin=new EventEmitter();child.stdin.end=(input:string)=>{call.input=input;queueMicrotask(()=>child.emit('close',0));};return child;
   }};
   assert.ok(id.startsWith('node:'));return require(id);
  }});
 const native=new output.NativeComputer(),frame={width:1280,height:854,dataURL:'data:image/jpeg;base64,eA=='};
 const secret='QA_unicode_é_🛰️';
 for(const input of [{type:'key',key:'Tab'},{type:'key',key:'Control+a'},{type:'text',text:secret}]){
  await native.input('window:42:0',input,frame,new AbortController().signal);
  const call=calls.at(-1)!;
  assert.equal(call.file,'powershell.exe');assert.equal(call.options.shell,false);
  assert.deepEqual(JSON.parse(call.input!),{id:'42',input,width:1280,height:854});
  assert.ok(!call.args.join(' ').includes(secret));
  assert.ok(!call.args.some(a=>/executionpolicy|bypass/i.test(a)));
  const script=Buffer.from(call.args.at(-1)!,'base64').toString('utf16le');
  assert.match(script,/\$k=\[System\.UInt16\]/);
  assert.doesNotMatch(script,/\$k=\[ushort\]/);
  assert.match(script,/GetForegroundWindow\(\)!=Target/);
 }
 const controller=new AbortController();controller.abort();
 await assert.rejects(native.input('window:42:0',{type:'key',key:'Enter'},frame,controller.signal));
 assert.equal(calls.length,3);
});

test('Windows accessibility is a bounded two-read window observation, never focus or input',()=>{
 const source=readFileSync(new URL('../src/main/computer-native.ts',import.meta.url),'utf8');
 const branch=source.slice(source.indexOf('if ($v.inspect)'),source.indexOf('[void][SynoraInput]::SetForegroundWindow($h)'));
 assert.match(branch,/FromHandle\(\$h\)/);assert.match(branch,/\$pass -lt 2/);assert.match(branch,/ElapsedMilliseconds -lt 3000/);
 assert.match(branch,/if\(\$c.IsPassword\)/);assert.match(branch,/exit 0/);
 assert.doesNotMatch(branch,/SetForegroundWindow|::Mouse|::Key|::Text|SetCursorPos|SendInput|ExecutionPolicy/);
});
