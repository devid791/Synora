import {test, expect, _electron} from "@playwright/test";
import {build} from "esbuild";
import {mkdtemp} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createServer} from "node:http";

test("real browser snapshots and clicks share CSS coordinates with independent UI/page zoom",async () => {
  const dir=await mkdtemp(join(tmpdir(),"synora-browser-zoom-")),bundle=join(dir,"host.cjs");
  await build({entryPoints:["tests/fixtures/computer-host.ts"],outfile:bundle,platform:"node",format:"cjs",bundle:true,external:["electron"]});
  const server=createServer((_req,res)=>{res.setHeader("Content-Type","text/html");res.end('<!doctype html><title>Zoom fixture</title><button style="margin:40px;padding:20px" onclick="this.textContent=\'Clicked\'">Target</button>');});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const url=`http://127.0.0.1:${(server.address() as any).port}/`;
  const app=await _electron.launch({args:[".","--disable-gpu"],chromiumSandbox:true,env:{...process.env,SYNORA_DATA_DIR:join(dir,"state")}});
  try {
    await app.firstWindow();
    const result=await app.evaluate(async ({BrowserWindow},{bundle,url})=>{
      const mod=process.getBuiltinModule("module").createRequire(bundle)(bundle),window=BrowserWindow.getAllWindows()[0];
      const browser=new mod.Browser(window,()=>{}),owner={conversationId:"qa",threadId:"qa-thread",turnId:"qa-turn",permission:"full",mode:"default"};
      const control=new mod.ComputerUse(browser,undefined,()=>owner,()=>{});
      const call=async (name:string,args:any)=>{
        const response=await control.call(name,args,AbortSignal.timeout(10000));
        if(response.isError)throw Error(JSON.stringify(response));
        return JSON.parse(response.content.find((c:any)=>c.type==="text").text);
      };
      const results=[];
      try {
        await control.configure({conversationId:"qa",browser:true,computer:false});
        const {tab_id}=await call("browser_open",{url});
        const wc=(window.contentView.children.at(-1) as any).webContents;
        for(let attempts=0;wc.isLoading()&&attempts<100;attempts++)await new Promise(r=>setTimeout(r,20));
        for(const [uiZoom,pageZoom] of [[1,1],[1.5,1],[1,1.5],[1.5,1.5],[1,0.8]]) {
          window.webContents.setZoomFactor(uiZoom);
          browser.layout(tab_id,{x:100,y:100,width:500,height:300});
          wc.setZoomFactor(pageZoom);
          await wc.executeJavaScript("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))");
          const observation=await call("browser_snapshot",{tab_id,format:"text"});
          const viewport=await wc.executeJavaScript("({width:innerWidth,height:innerHeight})");
          const button=observation.elements.find((e:any)=>e.role==="button"||e.tag==="button");
          if(!button)throw Error("No actual button observed");
          await call("browser_action",{tab_id,observation_id:observation.observation_id,input:{type:"click",...button.click,button:"left"}});
          const after=await call("browser_snapshot",{tab_id,format:"text"});
          results.push({uiZoom,pageZoom,width:observation.width,height:observation.height,viewport,clicked:after.text.includes("Clicked")});
          await wc.executeJavaScript("document.querySelector('button').textContent='Target'");
        }
      } finally {control.stop();browser.dispose();}
      return results;
    },{bundle,url});
    expect(result).toHaveLength(5);
    for(const row of result) {
      expect({width:row.width,height:row.height},JSON.stringify(row)).toEqual(row.viewport);
      expect(row.clicked,JSON.stringify(row)).toBe(true);
    }
  } finally {await app.close();await new Promise<void>(r=>server.close(()=>r()));}
});
