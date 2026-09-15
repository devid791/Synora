// Controlled upstream solely to inspect ORIGINAL Core approval RPC, NOT inference.
import {createServer} from 'node:http';
import {mkdtemp,mkdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync,zstdDecompressSync} from 'node:zlib';
import {AppServerTransport} from '../../src/engine/app-server-transport';
import {appServerEnvironment} from '../../src/engine/axiom-process';
import {controlTools} from '../../src/main/computer-use';
const root=await mkdtemp(join(tmpdir(),'synora-mcp-approval-trace-'));let calls=0,done=false,rpc:AppServerTransport;
const imageTrace=process.argv[2];
const imageResult=imageTrace?JSON.parse(await readFile(imageTrace,'utf8')).items.find((i:any)=>i.type==='mcpToolCall'&&i.tool==='browser_snapshot')?.result:undefined;
if(imageTrace&&!imageResult?.content?.some((c:any)=>c.type==='image'))throw Error('Expected owned QA screenshot result');
await mkdir(join(root,'core'));
const requests:unknown[]=[];
const server=createServer(async(req,res)=>{
 if(req.url==='/mcp'){
  const chunks=[];for await(const c of req)chunks.push(c);const r=JSON.parse(Buffer.concat(chunks).toString());
  if(r.id===undefined){res.writeHead(202).end();return;}
  const result=r.method==='initialize'?{protocolVersion:'2025-03-26',capabilities:{tools:{}},serverInfo:{name:'trace',version:'1'}}:r.method==='tools/list'?{tools:controlTools}:imageResult??{content:[{type:'text',text:'TRACE_EXECUTED'}]};
  res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:r.id,result}));return;
 }
 const chunks=[];for await(const c of req)chunks.push(c);let bytes:Buffer=Buffer.concat(chunks);if(req.headers['content-encoding']==='gzip')bytes=gunzipSync(bytes);if(req.headers['content-encoding']==='zstd')bytes=zstdDecompressSync(bytes);
 const body=JSON.parse(bytes.toString());calls++;
 await writeFile(join(root,'body-'+calls+'.json'),bytes,{mode:0o600});
 const item=calls===1?{id:'call_trace',call_id:'call_trace_original',type:'function_call',name:'browser_open',namespace:'mcp__trace',arguments:'{"url":"http://127.0.0.1:12345"}'}:{id:'msg_trace',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:'CONTROLLED_TRACE_DONE',annotations:[]}]};
 const response={id:'resp_'+calls,object:'response',model:body.model,status:'in_progress',output:[]};
 const send=(type:string,value:unknown)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,...value as any})}\n\n`);
 res.writeHead(200,{'Content-Type':'text/event-stream'});send('response.created',{response});send('response.in_progress',{response});send('response.output_item.added',{output_index:0,item});send('response.output_item.done',{output_index:0,item});send('response.completed',{response:{...response,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}});res.end();
});
await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+(server.address() as any).port;
const config={'model_provider':'qa','model_providers.qa.name':'Controlled QA','model_providers.qa.base_url':url,'model_providers.qa.wire_api':'responses','model_providers.qa.requires_openai_auth':false,'mcp_servers.trace.url':url+'/mcp','analytics.enabled':false};
rpc=new AppServerTransport({executable:process.env.SYNORA_TEST_CORE??'codex',args:['app-server','--stdio',...Object.entries(config).flatMap(([k,v])=>['-c',`${k}=${JSON.stringify(v)}`])],cwd:root,env:appServerEnvironment(join(root,'core')),onClose:()=>{},onNotification:e=>{if(e.method==='turn/completed')done=true;},onRequest:r=>{requests.push(r);console.log('ORIGINAL_CORE_REQUEST',JSON.stringify(r));rpc.respond(r.id,imageTrace?{result:{action:'accept',content:{},_meta:null}}:{error:{code:-32601,message:'Trace only: intentionally no approval response'}});}});
try{
 const init=await rpc.request('initialize',{clientInfo:{name:'synora_approval_trace',version:'1'},capabilities:{experimentalApi:true}});console.log(init);rpc.notify('initialized');
 const thread:any=await rpc.request('thread/start',{cwd:root,model:'gpt-5',sandbox:'workspace-write',approvalPolicy:'on-request'});
 await rpc.request('turn/start',{threadId:thread.thread.id,input:[{type:'text',text:'Controlled approval trace only.',text_elements:[]}]});
 const end=Date.now()+30000;while(!done&&Date.now()<end)await new Promise(r=>setTimeout(r,100));
 await writeFile(join(root,'requests.json'),JSON.stringify({done,calls,requests},null,2));console.log('TRACE_RECEIPT',root);
}catch(e){console.error(rpc.diagnostics);throw e;}finally{await rpc.close();server.close();}
