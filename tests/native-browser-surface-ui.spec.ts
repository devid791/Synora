import {test, expect} from "@playwright/test";
import {build} from "esbuild";
test("Native live slot reports geometry without frame polling and yields to overlays, resize, revoke and close", async ({page}) => {
  const script = (await build({entryPoints:["tests/fixtures/native-browser-surface-ui.tsx"], bundle:true,
    write:false, format:"iife", platform:"browser", define:{"process.env.NODE_ENV":'"production"'}})).outputFiles[0].text;
  await page.setViewportSize({width:1200,height:800});
  await page.setContent('<style>#root{position:absolute;left:200px;top:100px;width:500px;height:300px;overflow:hidden;display:flex}.native-browser-surface{flex:1;min-width:0;background:#fff}</style><div id="root"></div>');
  await page.addScriptTag({content:script});
  const last = () => page.evaluate(() => (window as any).nativeSurfaceFixture.state.layouts.at(-1));
  await expect.poll(last).toEqual({id:"tab-a",rect:{x:200,y:100,width:500,height:300}});
  await expect(page.getByRole("img")).toHaveCount(0);
  await page.evaluate(() => document.getElementById("root")!.style.width = "420px");
  await expect.poll(async () => (await last())?.rect.width).toBe(420);
  await page.evaluate(() => {
    const overlay = document.createElement("div"); overlay.id="consent";
    overlay.setAttribute("role","dialog"); overlay.style.cssText="position:fixed;inset:0;background:white;z-index:100";
    document.body.append(overlay);
  });
  await expect.poll(last).toBeNull();
  await page.evaluate(() => document.getElementById("consent")!.remove());
  await expect.poll(async () => (await last())?.id).toBe("tab-a");
  await page.evaluate(() => {
    const menu=document.createElement("div"); menu.id="small-menu";menu.role="menu";menu.popover="manual";
    menu.style.cssText="position:fixed;margin:0;left:260px;top:160px;width:40px;height:40px;background:white";
    document.body.append(menu);menu.showPopover();
  });
  await expect.poll(last).toBeNull();
  await page.evaluate(() => document.getElementById("small-menu")!.hidePopover());
  await expect.poll(async () => (await last())?.id).toBe("tab-a");
  // The second opening does not mutate the DOM attributes or child list.
  await page.evaluate(() => document.getElementById("small-menu")!.showPopover());
  await expect.poll(last).toBeNull();
  await page.evaluate(() => document.getElementById("small-menu")!.remove());
  await expect.poll(async () => (await last())?.id).toBe("tab-a");
  await page.evaluate(() => {const f=(window as any).nativeSurfaceFixture; f.state.blocked=true; f.render();});
  await expect.poll(last).toBeNull();
  await page.evaluate(() => {const f=(window as any).nativeSurfaceFixture; f.state.id="tab-b"; f.state.blocked=false; f.render();});
  await expect.poll(async () => (await last())?.id).toBe("tab-b");
  await page.evaluate(() => document.getElementById("root")!.style.top = "750px");
  await expect.poll(last).toBeNull();
  await page.evaluate(() => (window as any).nativeSurfaceFixture.unmount());
  await expect.poll(last).toBeNull();
});
