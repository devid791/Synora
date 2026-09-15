import test from "node:test";
import assert from "node:assert/strict";
import {isMcpToolApproval} from "../src/shared/mcp-tool-approval";
const original={threadId:"thread",turnId:"turn",serverName:"trace",mode:"form",message:'Allow tool "browser_open"?',_meta:{codex_approval_kind:"mcp_tool_call",persist:["session","always"],tool_params:{url:"https://example.com"}},requestedSchema:{type:"object",properties:{}}};
test("Original Core empty tool approval is recognized; arbitrary forms and unowned requests are not",()=>{
  assert.equal(isMcpToolApproval(original),true);
  for(const patch of [{mode:"url"},{mode:"openai/form"},{turnId:null},{turnId:""},{_meta:{}},{requestedSchema:{type:"object",properties:{password:{type:"string"}}}},{requestedSchema:{type:"object",properties:{},required:["secret"]}},{requestedSchema:{type:"object",properties:{},allOf:[{}]}}])assert.equal(isMcpToolApproval({...original,...patch}),false,JSON.stringify(patch));
});
