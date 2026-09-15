import {test, expect, _electron, type ElectronApplication} from "@playwright/test";
import {mkdtemp, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {createServer} from "node:http";
import {spawn, type ChildProcess} from "node:child_process";

// Real native child page and host IPC in an isolated Electron app. The control
// preview event is a fixture, NOT evidence of a model-driven inference turn.
test("native sidebar displays the actual interactive page, follows layout and yields to overlays and Stop", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-native-sidebar-"));
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "text/html");
    const searched = new URL(req.url!, "http://localhost").searchParams.get("q") === "Lazio cars";
    res.end(`<!doctype html><title>Live search fixture</title><style>body{font:18px sans-serif;margin:16px}input,button{font:inherit;padding:8px;max-width:100%;box-sizing:border-box}footer{margin-top:1600px}</style>
      <h1>Search catalogue</h1><form><input name="q" aria-label="Search query"><button>Search</button></form>
      <p id="result">${searched ? "Results: Lazio cars" : "Type a search"}</p><output>Not edited</output>
      <script>document.querySelector('input').addEventListener('input',e=>document.querySelector('output').textContent=e.target.value)</script>
      <footer>End of results</footer>`);
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as any).port}/`;
  let app: ElectronApplication | undefined;
  let wm: ChildProcess | undefined;
  try {
    if (process.env.SYNORA_QA_WINDOW_MANAGER) {
      wm=spawn(process.env.SYNORA_QA_WINDOW_MANAGER,["-f",resolve("tests/fixtures/computer-twm.conf")],{stdio:"ignore"});
      await new Promise(r => setTimeout(r,250));
      expect(wm.exitCode).toBe(null);
    }
    app = await _electron.launch({args:[".","--disable-gpu"], chromiumSandbox:true,
      env:{...process.env, SYNORA_DATA_DIR:join(dir,"state")}});
    const page = await app.firstWindow();
    const screenshot = async (name: string) => {
      // The parent renderer screenshot excludes native child views. Capture
      // only this owned OS window, never a synthetic image composition.
      const image=await app!.evaluate(async ({BrowserWindow,desktopCapturer}) => {
        const window=BrowserWindow.getAllWindows()[0];
        const sources=await desktopCapturer.getSources({types:["window"],thumbnailSize:{width:1800,height:1200}});
        const source=sources.find(s => s.id===window.getMediaSourceId());
        if (!source || source.thumbnail.isEmpty()) throw Error("Owned native window capture unavailable; a renderer-only image is not proof of the page display");
        return source.thumbnail.toPNG().toString("base64");
      });
      await writeFile(`test-results/computer-control/${name}.png`,Buffer.from(image,"base64"));
    };
    const errors: string[] = [];
    page.on("pageerror",e => errors.push(e.message));
    await expect(page.getByRole("heading",{name:"A space for focused work."})).toBeVisible();
    await page.getByRole("button",{name:"New conversation",exact:true}).click();
    await page.getByRole("button",{name:"Computer & browser",exact:true}).click();
    const panel = page.getByRole("complementary",{name:"Computer & browser"});
    await panel.getByLabel("Internal browser",{exact:true}).click();
    await expect(panel.getByLabel("Internal browser",{exact:true})).toBeChecked();
    const state = await page.evaluate(async url => {
      const opening = await window.synora.browserOpen(url);
      const status = await window.synora.controlStatus();
      if (!opening.ok || !status.ok) throw Error("QA browser setup failed");
      const tab = opening.value.at(-1)!;
      return {...status.value, preview:{kind:"browser" as const,id:tab.id,title:tab.title,url,at:Date.now()}};
    },url);
    await app.evaluate(({BrowserWindow},state) => {
      const window = BrowserWindow.getAllWindows()[0];
      const view = window.contentView.children.at(-1) as any;
      (globalThis as any).sidebarQA = {view, captures:0};
      const capture = view.webContents.capturePage.bind(view.webContents);
      view.webContents.capturePage = (...args: any[]) => { (globalThis as any).sidebarQA.captures++; return capture(...args); };
      window.webContents.send("synora:event",{kind:"control",state});
    },state);
    const native = () => app!.evaluate(() => {
      const {view,captures} = (globalThis as any).sidebarQA;
      return {visible:view.getVisible(),bounds:view.getBounds(),captures};
    });
    const dom = (script: string) => app!.evaluate((_e,script) =>
      (globalThis as any).sidebarQA.view.webContents.executeJavaScript(script),script);
    const assertAligned = async () => {
      await expect.poll(async () => {
        const slot = await panel.locator(".native-browser-surface").boundingBox();
        const current = await native();
        const zoom = await app!.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.getZoomFactor());
        if (!slot || !current.visible) return false;
        return Object.entries(slot).every(([key,value]) => Math.abs((current.bounds as any)[key] - Math.round(value * zoom)) <= 1);
      }).toBe(true);
      await expect(panel.getByRole("button",{name:"Stop control",exact:true})).toBeVisible();
      await expect(panel.locator("img, .remote-browser")).toHaveCount(0);
    };
    await assertAligned();
    await expect.poll(() => dom("document.title")).toBe("Live search fixture");
    // Model transport sends real input into this very same displayed page.
    const send = async (input: any) => {
      const result = await page.evaluate(({id,input}) => window.synora.browserInput(id,input),{id:state.preview.id,input});
      expect(result.ok).toBe(true);
    };
    const point = await dom("(()=>{const r=document.querySelector('input').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()");
    await send({type:"click",...point,button:"left"});
    await send({type:"text",text:"Lazio cars"});
    await expect.poll(() => dom("document.querySelector('output').textContent")).toBe("Lazio cars");
    await screenshot("native-sidebar-typed");
    await send({type:"key",key:"Enter"});
    await expect.poll(() => dom("document.getElementById('result').textContent")).toBe("Results: Lazio cars");
    await expect(panel.locator(".control-url")).toContainText("q=Lazio+cars");
    await send({type:"scroll",x:100,y:180,deltaX:0,deltaY:600});
    await expect.poll(() => dom("scrollY")).toBeGreaterThan(0);
    // User input goes directly to the native view, without the frame proxy.
    await app.evaluate(async () => {
      const wc=(globalThis as any).sidebarQA.view.webContents;
      await wc.executeJavaScript("scrollTo(0,0)");
      const p=await wc.executeJavaScript("(()=>{const r=document.querySelector('input').getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()");
      wc.focus();
      wc.sendInputEvent({type:"mouseDown",...p,button:"left",clickCount:1});
      wc.sendInputEvent({type:"mouseUp",...p,button:"left",clickCount:1});
      await wc.insertText("User edited query");
    });
    await expect.poll(() => dom("document.querySelector('output').textContent")).toBe("User edited query");
    for (const size of [{width:1440,height:900},{width:1024,height:700}]) {
      await app.evaluate(({BrowserWindow},size) => BrowserWindow.getAllWindows()[0].setSize(size.width,size.height),size);
      await assertAligned();
      await screenshot(`native-sidebar-${size.width}`);
    }
    await app.evaluate(({BrowserWindow}) => {
      const window=BrowserWindow.getAllWindows()[0]; window.setSize(1440,900); window.webContents.setZoomFactor(1.5);
    });
    await assertAligned();
    await screenshot("native-sidebar-zoom-150");
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await page.evaluate(() => window.synora.preferences({theme:"dark"}));
    await assertAligned();
    await screenshot("native-sidebar-dark");
    // DOM dialogs cannot be drawn over child views: the host hides the page.
    await page.evaluate(() => {
      const overlay=document.createElement("div");overlay.id="qa-overlay";overlay.role="dialog";
      overlay.style.cssText="position:fixed;inset:0;z-index:1000;background:white";document.body.append(overlay);
    });
    await expect.poll(async () => (await native()).visible).toBe(false);
    await page.evaluate(() => document.getElementById("qa-overlay")!.remove());
    await assertAligned();
    const emit = (value: typeof state) => app!.evaluate(({BrowserWindow},state) =>
      BrowserWindow.getAllWindows()[0].webContents.send("synora:event",{kind:"control",state}),value);
    await emit({...state,pending:{id:"qa-pending",conversationId:state.grant!.conversationId,
      title:"Allow control action",details:"Click the owned fixture's Search button."}});
    await expect.poll(async () => (await native()).visible).toBe(false);
    await app.evaluate(({BrowserWindow}) => {
      const window=BrowserWindow.getAllWindows()[0];window.setSize(900,640);window.webContents.setZoomFactor(1.5);
    });
    const allow = panel.getByRole("button",{name:"Allow once",exact:true});
    await allow.scrollIntoViewIfNeeded();
    expect(await allow.evaluate(button => {
      const r=button.getBoundingClientRect();const hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);
      return hit===button || !!hit && button.contains(hit);
    })).toBe(true);
    await expect(panel.getByRole("button",{name:"Stop control",exact:true})).toBeVisible();
    // A different conversation cannot display or submit this pending request.
    await app.evaluate(({BrowserWindow}) => {
      const window=BrowserWindow.getAllWindows()[0];window.webContents.setZoomFactor(1);window.setSize(1440,900);
    });
    await page.evaluate(id => window.synora.conversationUpdate(id,{title:"Sidebar original chat"}),state.grant!.conversationId);
    await page.getByRole("button",{name:"New conversation",exact:true}).click();
    await expect(panel.locator(".control-consent, .control-preview")).toHaveCount(0);
    await page.getByText("Sidebar original chat",{exact:true}).click();
    await emit(state);
    await app.evaluate(({BrowserWindow}) => {
      const window=BrowserWindow.getAllWindows()[0];window.webContents.setZoomFactor(1);window.setSize(1440,900);
    });
    await assertAligned();
    await panel.getByRole("button",{name:"Open full browser",exact:true}).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(async () => (await native()).bounds.width).toBeGreaterThan(800);
    await page.getByRole("button",{name:"Workspace",exact:true}).click();
    await expect.poll(async () => (await native()).visible).toBe(false);
    await page.getByRole("button",{name:"Computer & browser",exact:true}).click();
    await assertAligned();
    await panel.getByRole("button",{name:"Stop control",exact:true}).click();
    await expect.poll(async () => (await native()).visible).toBe(false);
    await expect(panel.locator(".native-browser-surface")).toHaveCount(0);
    expect((await native()).captures).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    wm?.kill("SIGTERM");
    await new Promise<void>(r => server.close(() => r()));
  }
});
