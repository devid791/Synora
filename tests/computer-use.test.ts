import test from "node:test";
import assert from "node:assert/strict";
import { ComputerUse, controlTools } from "../src/main/computer-use";
import { ControlMcp } from "../src/main/control-mcp";
import type { ControlOwner, ComputerAdapter } from "../src/shared/computer-use";
import type { BrowserService } from "../src/main/service";
import Ajv from "ajv";
import { controlInputSchema, controlInputJsonSchema } from "../src/shared/computer-use";

test("MCP input schema matches runtime-required click/key/text/scroll fields",()=>{
 const validate=new Ajv().compile(controlInputJsonSchema);
 const values=[{type:'click',x:1,y:2,button:'left'},{type:'click',x:1,y:2},{type:'click',x:-1,y:2,button:'left'},
  {type:'key',key:'Tab'},{type:'key',key:'Control+a'},{type:'key',key:'F12'},{type:'key',key:'Tab',text:'extra'},
  {type:'text',text:'é 🛰️'},{type:'text',text:''},{type:'text',text:'x'.repeat(4001)},
  {type:'scroll',x:0,y:0,deltaX:0,deltaY:500},{type:'scroll',x:0,y:0,deltaY:1},{type:'scroll',x:0,y:0,deltaX:0,deltaY:2001}];
 for(const value of values)assert.equal(validate(value),controlInputSchema.safeParse(value).success,JSON.stringify(value));
 for(const name of ['browser_action','computer_action'])assert.deepEqual(controlTools.find(t=>t.name===name)!.inputSchema.properties.input,controlInputJsonSchema);
});

const frame = {
  dataURL: "data:image/png;base64,aGVsbG8=",
  width: 800,
  height: 600,
};
test("Native observations declare actual image coordinates without silently normalizing model input",async()=>{
 const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
 const result=text(await call(f.control,'computer_snapshot',{window_id:'window:42:0'}));
 assert.equal(result.coordinate_space.units,'image_pixels');
 assert.equal(result.coordinate_space.origin,'top_left');
 assert.equal(result.coordinate_space.width,800);assert.equal(result.coordinate_space.height,600);
 assert.match(controlTools.find(t=>t.name==='computer_action')!.description,/NOT screen, normalized, Retina/);
 const browser=text(await call(f.control,'browser_snapshot',{tab_id:'tab'}));
 assert.equal(browser.coordinate_space,undefined);
});
test('Native snapshot retains its real image and provides read-only accessibility data under the same grant',async()=>{
 const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
 f.computer.inspect=async(id,seen,signal)=>{assert.equal(id,'window:42:0');assert.equal(seen,frame);assert(!signal.aborted);return {available:true,elements:[]};};
 const r=await call(f.control,'computer_snapshot',{window_id:'window:42:0'});
 assert.equal(r.content.length,2);assert.equal(text(r).accessibility.available,true);assert.equal(f.inputs(),0);
});
const ownerTemplate: ControlOwner = {
  conversationId: "chat",
  threadId: "thread",
  turnId: "turn",
  permission: "ask",
  mode: "default",
};
test("A newly resized browser rejects even a young observation before native input", async () => {
  const f = fixture(); f.owner({...ownerTemplate, permission: "full"}); await enable(f.control);
  const observed = text(await call(f.control, "browser_snapshot", {tab_id: "tab"}));
  f.browser.frame = async () => ({...frame, width: 640});
  await assert.rejects(call(f.control, "browser_action", {tab_id: "tab", observation_id: observed.observation_id,
    input: {type: "click", x: 10, y: 10, button: "left"}}), /changed.*fresh snapshot/);
  assert.equal(f.inputs(), 0);
  const refreshed = text(await call(f.control, "browser_snapshot", {tab_id: "tab"}));
  await call(f.control, "browser_action", {tab_id: "tab", observation_id: refreshed.observation_id,
    input: {type: "click", x: 10, y: 10, button: "left"}});
  assert.equal(f.inputs(), 1);
});
test("Browser text and captured frame must describe the same viewport", async () => {
  const f = fixture(); f.owner({...ownerTemplate, permission: "full"}); await enable(f.control);
  const inspect = f.browser.inspect!;
  f.browser.inspect = async id => ({...await inspect(id), viewport: {width: 640, height: 600}});
  await assert.rejects(call(f.control, "browser_snapshot", {tab_id: "tab"}), /viewport changed while capturing/);
  assert.equal(f.inputs(), 0);
});
function fixture() {
  let owner: ControlOwner | null = { ...ownerTemplate },
    url = "https://example.com/",
    inputs = 0,
    opens = 0;
  const browser: BrowserService = {
    list: () => [
      {
        id: "tab",
        title: "Fixture",
        url,
        loading: false,
        error: null,
        canGoBack: false,
        canGoForward: false,
      },
    ],
    open: (value) => {
      url = value;
      opens++;
      return browser.list();
    },
    navigate: (_id, value) => {
      url = value;
      opens++;
    },
    action: () => browser.list(),
    layout: () => {},
    dispose: () => {},
    frame: async () => frame,
    input: async () => {
      inputs++;
    },
    inspect: async () => ({
      title: "Fixture",
      url,
      text: "Untrusted page",
      elements: [],
    }),
  };
  const computer: ComputerAdapter = {
    status: async () => ({ supported: true }),
    windows: async () => [
      { id: "window:42:0", title: "Calculator", app: "calc" },
      { id: "window:43:0", title: "Synora", app: "synora" },
    ],
    capture: async () => frame,
    input: async () => {
      inputs++;
    },
  };
  const control = new ComputerUse(
    browser,
    computer,
    () => owner,
    () => {},
  );
  return {
    control,
    browser,
    computer,
    owner: (value: ControlOwner | null) => (owner = value),
    inputs: () => inputs,
    opens: () => opens,
    url: (v: string) => (url = v),
  };
}
async function until(fn: () => boolean) {
  const end = Date.now() + 2500;
  while (!fn()) {
    if (Date.now() > end) throw Error("Test deadline");
    await new Promise((r) => setTimeout(r, 2));
  }
}
async function approved<T>(
  control: ComputerUse,
  job: Promise<T>,
  allow = true,
) {
  await until(() => !!control.snapshot().pending);
  control.approve(control.snapshot().pending!.id, allow);
  return job;
}
const call = (c: ComputerUse, name: string, args: unknown = {}) =>
  c.call(name, args, new AbortController().signal);
const text = (r: Awaited<ReturnType<typeof call>>) =>
  JSON.parse((r.content[0] as { text: string }).text);
const enable = (c: ComputerUse) =>
  c.configure({ conversationId: "chat", browser: true, computer: true });

test("Browser text observations retain coordinates, consent and local frames; explicit vision and native snapshots keep images",async()=>{
 const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
 for(const format of [undefined,'text','image']){
  const r=await call(f.control,'browser_snapshot',{tab_id:'tab',...(format?{format}:{})});
  assert.equal(r.content.length,format==='image'?2:1);
  assert.equal(text(r).text,'Untrusted page');assert.equal(text(r).width,frame.width);
  assert.deepEqual(f.control.snapshot().preview?.frame,frame);
  await call(f.control,'browser_action',{tab_id:'tab',observation_id:text(r).observation_id,input:{type:'click',x:20,y:20,button:'left'}});
 }
 assert.equal(f.inputs(),3);
 await assert.rejects(call(f.control,'browser_snapshot',{tab_id:'tab',format:'script'}));
 const r=await call(f.control,'computer_snapshot',{window_id:'window:42:0'});assert.equal(r.content.length,2);
 const tool=controlTools.find(t=>t.name==='browser_snapshot')!;
 assert.deepEqual((tool.inputSchema.properties.format as any).enum,['text','image']);
 f.control.stop();
});

test("Slow models may use an old observation only after an exact fresh frame check; changed pixels or dimensions never execute", async () => {
  for (const kind of ['browser','computer'] as const) for (const changed of ['none','pixels','size'] as const) {
    const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
    const args=kind==='browser'?{tab_id:'tab'}:{window_id:'window:42:0'};
    const observed=text(await call(f.control,kind+'_snapshot',args));
    (f.control as unknown as {observation:{at:number}}).observation.at-=121000;
    let captures=0;
    const capture=async()=>{captures++;return changed==='pixels'?{...frame,dataURL:'data:image/png;base64,changed'}:changed==='size'?{...frame,width:801}:frame;};
    if(kind==='browser')f.browser.frame=capture;else f.computer.capture=capture;
    const action=call(f.control,kind+'_action',{...args,observation_id:observed.observation_id,input:{type:'click',x:50,y:50,button:'left'}});
    if(changed==='none'){await action;assert.equal(f.inputs(),1);}
    else {await assert.rejects(action,/changed while the model/);assert.equal(f.inputs(),0);}
    assert.equal(captures,1);f.control.stop();
  }
});

test("Native text/image schema preserves the image default and rejects unsupported formats",async()=>{
 const tool=controlTools.find(t=>t.name==='computer_snapshot')!;
 const validate=new Ajv().compile(tool.inputSchema);
 assert.equal((tool.inputSchema.properties.format as any).default,'image');
 assert.deepEqual(tool.inputSchema.required,['window_id']);
 assert.equal((controlTools.find(t=>t.name==='browser_snapshot')!.inputSchema.properties.format as any).default,'text');
 const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
 for(const format of [undefined,'text','image','script',null]){
  const args={window_id:'window:42:0',...(format===undefined?{}:{format})};
  const valid=format===undefined||format==='text'||format==='image';
  assert.equal(validate(args),valid);
  if(!valid){await assert.rejects(call(f.control,'computer_snapshot',args));continue;}
  const result=await call(f.control,'computer_snapshot',args);
  assert.equal(text(result).image_included,format!=='text');
  assert.equal(result.content.length,format==='text'?1:2);
  if(format!=='text')assert.deepEqual(result.content[1],{type:'image',mimeType:'image/png',data:'aGVsbG8='});
 }
 f.control.stop();
});

test("Native text observations retain real metadata, preview and one-use native input with no Full access prompt",async()=>{
 const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
 const accessibility={available:true,elements:[{role:'textField',name:'Query',value:'Lazio · 🚗',focused:true,disabled:false,click:{x:120,y:180},bounds:{left:20,top:160,width:200,height:40}}]};
 f.computer.inspect=async()=>accessibility;
 const r=await call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'text'});
 assert.equal(r.content.length,1);assert.deepEqual(text(r).accessibility,accessibility);
 assert.deepEqual(f.control.snapshot().preview?.frame,frame);assert.equal(text(r).coordinate_space.width,800);
 assert.equal(f.inputs(),0);assert.equal(f.control.snapshot().pending,null);
 const args={window_id:'window:42:0',observation_id:text(r).observation_id,input:{type:'click',x:120,y:180,button:'left'}};
 await call(f.control,'computer_action',args);assert.equal(f.inputs(),1);
 await assert.rejects(call(f.control,'computer_action',args),/fresh snapshot/);
 assert.equal(f.control.snapshot().pending,null);f.control.stop();
});

test("Missing or empty native accessibility is honest and requests explicit vision without silently sending images",async()=>{
 for(const inspection of [undefined,{available:false,reason:'Application is not accessible',elements:[]},{available:true,elements:[]}]){
  const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
  if(inspection)f.computer.inspect=async()=>inspection;
  const r=await call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'text'});
  assert.equal(r.content.length,1);assert.equal(text(r).image_included,false);
  assert.match(text(r).observation_hint,/format=image/);assert.match(text(r).observation_hint,/do not guess/);
  if(!inspection)assert.equal(text(r).accessibility.available,false);
  if(inspection?.reason)assert.equal(text(r).accessibility.reason,inspection.reason);
  assert.deepEqual(f.control.snapshot().preview?.frame,frame);
  const visual=await call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'image'});
  assert.equal(visual.content.length,2);assert.equal(text(visual).image_included,true);
  assert.equal(f.inputs(),0);f.control.stop();
 }
});

test("Native text observations retain Ask, owner, protected-window and Plan safeguards",async()=>{
 const f=fixture();await enable(f.control);
 const r=await approved(f.control,call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'text'}));
 const args={window_id:'window:42:0',observation_id:text(r).observation_id,input:{type:'text',text:'no execution'}};
 await assert.rejects(approved(f.control,call(f.control,'computer_action',args),false),/declined/);
 assert.equal(f.inputs(),0);
 await assert.rejects(call(f.control,'computer_snapshot',{window_id:'window:43:0',format:'text'}),/prohibited/);
 f.owner({...ownerTemplate,permission:'full',mode:'plan'});
 const plan=await call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'text'});
 await assert.rejects(call(f.control,'computer_action',{...args,observation_id:text(plan).observation_id}),/Execute mode/);
 f.owner({...ownerTemplate,permission:'full',mode:'default'});
 f.computer.inspect=async()=>{f.owner({...ownerTemplate,conversationId:'another'});return {available:true,elements:[]};};
 await assert.rejects(call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'text'}),/no longer active/);
 assert.equal(f.inputs(),0);f.control.stop();
});

test("Slow native text observations still fail closed when their real local frame changes",async()=>{
 const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
 const observed=text(await call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'text'}));
 (f.control as unknown as {observation:{at:number}}).observation.at-=121000;
 f.computer.capture=async()=>({...frame,dataURL:'data:image/png;base64,changed'});
 await assert.rejects(call(f.control,'computer_action',{window_id:'window:42:0',observation_id:observed.observation_id,input:{type:'click',x:50,y:50,button:'left'}}),/changed while the model/);
 assert.equal(f.inputs(),0);f.control.stop();
});

test("Full access never adds a second application consent when a browser redirect is observed", async () => {
  const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
  f.browser.inspect=async()=>{f.url('https://redirect.example/');return {url:'https://redirect.example/',title:'Redirect',text:'Destination',elements:[]};};
  await call(f.control,'browser_snapshot',{tab_id:'tab'});
  assert.equal(f.control.snapshot().pending,null);f.control.stop();
});

test("Downgrading Full access requires new site and window read consent in the same conversation",async()=>{
 for(const permission of ['ask','auto-review'] as const){
  const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
  await call(f.control,'browser_snapshot',{tab_id:'tab'});
  await call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'text'});
  f.owner({...ownerTemplate,permission,turnId:'next-turn'});
  for(const [name,args,title] of [
   ['browser_snapshot',{tab_id:'tab'},'Allow website access'],
   ['computer_snapshot',{window_id:'window:42:0',format:'text'},'Allow application access'],
  ] as const){
   let settled=false;
   const pending=call(f.control,name,args).finally(()=>{settled=true;});
   try{
    await until(()=>settled||!!f.control.snapshot().pending);
    assert.equal(settled,false,'Full-derived read consent must not survive a permission downgrade');
    assert.equal(f.control.snapshot().pending?.title,title);
    f.control.approve(f.control.snapshot().pending!.id,true);
    await pending;
   }catch(error){f.control.stop();await pending.catch(()=>{});throw error;}
  }
  f.control.stop();
 }
});

test("An explicit permission change clears only its conversation's observations without disabling control or resurrecting Stop",async()=>{
 const f=fixture();f.owner({...ownerTemplate,permission:'full'});await enable(f.control);
 const observed=text(await call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'text'}));
 const before=f.control.snapshot();
 assert.equal(f.control.permissionChanged('another-chat'),false);
 assert.deepEqual(f.control.snapshot(),before);
 assert.equal(f.control.permissionChanged('chat'),true);
 assert.deepEqual(f.control.snapshot().grant,before.grant);
 assert.equal(f.control.snapshot().preview,null);assert.equal(f.control.snapshot().pending,null);
 await assert.rejects(call(f.control,'computer_action',{window_id:'window:42:0',observation_id:observed.observation_id,input:{type:'click',x:40,y:50,button:'left'}}),/fresh snapshot/);
 assert.equal(f.inputs(),0);
 f.control.stop();assert.equal(f.control.permissionChanged('chat'),false);
 assert.equal(await f.control.prepareFullAccess('chat'),false);
});

test("Permission changes abort pending read consent and late decisions cannot grant it",async()=>{
 const f=fixture();await enable(f.control);
 const pending=call(f.control,'computer_snapshot',{window_id:'window:42:0',format:'text'});
 await until(()=>!!f.control.snapshot().pending);
 const id=f.control.snapshot().pending!.id;
 f.control.permissionChanged('chat');
 await assert.rejects(pending,/permissions changed/);
 assert.throws(()=>f.control.approve(id,true),/Stale/);
 assert.equal(f.control.snapshot().preview,null);assert.equal(f.inputs(),0);
 f.control.stop();
});
async function observe(c: ComputerUse) {
  return text(
    await approved(c, call(c, "browser_snapshot", { tab_id: "tab" })),
  );
}

test("Control is opt-in and reports honest capabilities without an active model turn", async () => {
  const f = fixture();
  f.owner(null);
  assert.equal(text(await call(f.control, "control_status")).enabled, null);
  await assert.rejects(call(f.control, "browser_tabs"), /Enable control/);
  const noNative = new ComputerUse(
    f.browser,
    undefined,
    () => ownerTemplate,
    () => {},
  );
  assert.equal((await noNative.availability()).available.computer, false);
  await assert.rejects(enable(noNative), /unavailable/);
});
test("Schemas are strict; no eval, file URLs, generic shell, arbitrary keys or negative coordinates", async () => {
  const f = fixture();
  await enable(f.control);
  await assert.rejects(
    call(f.control, "browser_open", { url: "file:///etc/passwd" }),
  );
  await assert.rejects(
    call(f.control, "browser_snapshot", {
      tab_id: "tab",
      eval: "process.exit()",
    }),
  );
  await assert.rejects(
    call(f.control, "browser_action", {
      tab_id: "tab",
      observation_id: "bad",
      input: { type: "key", key: "exec('rm')" },
    }),
  );
  await assert.rejects(call(f.control, "exec", {}), /Unknown/);
  assert.equal(controlTools.length, 8);
  assert.equal(f.inputs(), 0);
  assert.equal(f.opens(), 0);
});
test("Site consent precedes observation; denial never returns a page or screen", async () => {
  const f = fixture();
  await enable(f.control);
  await assert.rejects(
    approved(
      f.control,
      call(f.control, "browser_snapshot", { tab_id: "tab" }),
      false,
    ),
    /declined/,
  );
  assert.equal(f.control.snapshot().preview, null);
  const result = await observe(f.control);
  assert.equal(result.text, "Untrusted page");
  assert.match(result.observation_id, /^[a-f0-9-]{36}$/);
});
test("Ask and auto-review require explicit approval for input; same observation cannot execute twice", async () => {
  for (const permission of ["ask", "auto-review"] as const) {
    const f = fixture();
    f.owner({ ...ownerTemplate, permission });
    await enable(f.control);
    const observed = await observe(f.control);
    const args = {
      tab_id: "tab",
      observation_id: observed.observation_id,
      input: { type: "click", x: 30, y: 40, button: "left" },
    };
    await approved(f.control, call(f.control, "browser_action", args));
    assert.equal(f.inputs(), 1);
    await assert.rejects(
      call(f.control, "browser_action", args),
      /fresh snapshot/,
    );
  }
});
test("Full access executes scoped browser/native actions without extra prompts and Stop stays revoked", async () => {
  const f = fixture();
  f.owner({ ...ownerTemplate, permission: "full" });
  assert.equal(await f.control.prepareFullAccess("chat"), true);
  const observed = text(await call(f.control, "browser_snapshot", { tab_id: "tab" }));
  await call(f.control, "browser_action", {
    tab_id: "tab",
    observation_id: observed.observation_id,
    input: { type: "text", text: "cars Lazio" },
  });
  assert.equal(f.inputs(), 1);
  assert.equal(f.control.snapshot().grant!.conversationId, "chat");
  assert.equal(f.control.snapshot().pending, null);
  const native = text(await call(f.control, "computer_snapshot", {window_id:"window:42:0"}));
  await call(f.control, "computer_action", {window_id:"window:42:0",observation_id:native.observation_id,input:{type:"text",text:"test"}});
  assert.equal(f.inputs(),2);
  assert.equal(f.control.snapshot().pending,null);
  await assert.rejects(call(f.control,"computer_snapshot",{window_id:"window:43:0"}),/prohibited/);
  f.control.stop();
  assert.equal(await f.control.prepareFullAccess("chat"),false);
  await assert.rejects(call(f.control,"browser_tabs"),/Enable control/);
  await enable(f.control);
  assert.ok(f.control.snapshot().grant);
});
test("Plan mode cannot navigate or send keyboard/mouse input", async () => {
  const f = fixture();
  await enable(f.control);
  const observed = await observe(f.control);
  f.owner({ ...ownerTemplate, mode: "plan" });
  await assert.rejects(
    call(f.control, "browser_open", {
      tab_id: "tab",
      url: "https://example.com/new",
    }),
    /Execute/,
  );
  await assert.rejects(
    call(f.control, "browser_action", {
      tab_id: "tab",
      observation_id: observed.observation_id,
      input: { type: "text", text: "test" },
    }),
    /Execute/,
  );
  assert.equal(f.inputs(), 0);
  assert.equal(f.opens(), 0);
});
test("Stop cancels pending approval immediately and revokes grants, previews and observations", async () => {
  const f = fixture();
  await enable(f.control);
  const job = call(f.control, "browser_snapshot", { tab_id: "tab" });
  await until(() => !!f.control.snapshot().pending);
  const request = f.control.snapshot().pending!.id;
  f.control.stop();
  await assert.rejects(job);
  assert.equal(f.control.snapshot().grant, null);
  assert.throws(() => f.control.approve(request, true), /Stale/);
  assert.equal(f.inputs(), 0);
});
test("Ended or switched turn cannot resume a pending approval or reuse a prior observation", async () => {
  const f = fixture();
  await enable(f.control);
  const job = call(f.control, "browser_snapshot", { tab_id: "tab" });
  await until(() => !!f.control.snapshot().pending);
  f.owner(null);
  await assert.rejects(job);
  assert.equal(f.control.snapshot().preview, null);
});
test("Cross-conversation grants, out-of-image input and concurrent actions are rejected", async () => {
  const f = fixture();
  await enable(f.control);
  const job = call(f.control, "browser_snapshot", { tab_id: "tab" });
  await until(() => !!f.control.snapshot().pending);
  await assert.rejects(call(f.control, "browser_tabs"), /Another control/);
  f.control.approve(f.control.snapshot().pending!.id, true);
  await job;
  f.owner({ ...ownerTemplate, permission: "full" });
  // A policy change correctly invalidates the previous observation. This
  // separate assertion exercises bounds checking with a fresh Full snapshot.
  const observed = text(await call(f.control, "browser_snapshot", {tab_id:"tab"}));
  await assert.rejects(
    call(f.control, "browser_action", {
      tab_id: "tab",
      observation_id: observed.observation_id,
      input: { type: "click", x: 900, y: 50, button: "left" },
    }),
    /outside/,
  );
  f.owner({ ...ownerTemplate, conversationId: "other" });
  await assert.rejects(call(f.control, "browser_tabs"), /Enable control/);
  assert.equal(f.inputs(), 0);
});
test("Window observation requests consent; protected apps cannot be controlled", async () => {
  const f = fixture();
  await enable(f.control);
  await assert.rejects(
    call(f.control, "computer_snapshot", { window_id: "window:43:0" }),
    /prohibited/,
  );
  const result = text(
    await approved(
      f.control,
      call(f.control, "computer_snapshot", { window_id: "window:42:0" }),
    ),
  );
  assert.equal(result.target, "window:42:0");
  assert.equal(f.control.snapshot().preview!.kind, "computer");
});
test("Changing permissions while an action awaits approval cancels it without input", async () => {
  const f = fixture();
  await enable(f.control);
  const observed = await observe(f.control);
  const action = call(f.control, "browser_action", {
    tab_id: "tab",
    observation_id: observed.observation_id,
    input: { type: "key", key: "Enter" },
  });
  await until(() => !!f.control.snapshot().pending);
  f.owner({ ...ownerTemplate, mode: "plan" });
  await assert.rejects(action);
  assert.equal(f.inputs(), 0);
});
test("Navigation invalidates input; new origins need new consent", async () => {
  const f = fixture();
  f.owner({ ...ownerTemplate, permission: "full" });
  await enable(f.control);
  const observed = text(await call(f.control,"browser_snapshot",{tab_id:"tab"}));
  f.url("https://example.com/changed");
  await assert.rejects(
    call(f.control, "browser_action", {
      tab_id: "tab",
      observation_id: observed.observation_id,
      input: { type: "key", key: "Enter" },
    }),
    /navigated/,
  );
  f.url("https://example.net/");
  f.owner({ ...ownerTemplate, permission: "ask" });
  await approved(
    f.control,
    call(f.control, "browser_snapshot", { tab_id: "tab" }),
  );
  assert.equal(f.inputs(), 0);
});
test("MCP is private, rejects browser-origin access and exposes real tools without a public command API", async () => {
  const f = fixture(),
    bridge = new ControlMcp(f.control);
  await bridge.start();
  try {
    const endpoint = bridge.integration!.endpoint;
    const rpc = (method: string, headers: Record<string, string> = {}) =>
      fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
      });
    assert.equal(
      (await rpc("tools/list", { Origin: "https://evil.example" })).status,
      403,
    );
    assert.equal(
      (await fetch(endpoint.replace(/control\/.+$/, "control/wrong"))).status,
      403,
    );
    assert.equal((await fetch(endpoint)).status, 405);
    const init = await (await rpc("initialize")).json();
    assert.equal(init.result.serverInfo.name, "synora-computer-use");
    const tools = await (await rpc("tools/list")).json();
    assert.equal(tools.result.tools.length, 8);
    assert.equal((await (await rpc("exec")).json()).error.code, -32601);
    bridge.rotate();
    assert.notEqual(bridge.integration!.endpoint, endpoint);
    assert.equal(
      (await rpc("tools/list")).status,
      403,
      "old Core capability is revoked after a new grant",
    );
  } finally {
    await bridge.dispose();
  }
});
