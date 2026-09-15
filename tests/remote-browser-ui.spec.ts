import {test,expect} from '@playwright/test';
import {build} from 'esbuild';
test('Preview reports a current capture failure, clears it after recovery and never shows another tab’s frame',async({page})=>{
 const script=(await build({entryPoints:['tests/fixtures/remote-browser-ui.tsx'],bundle:true,write:false,format:'iife',platform:'browser',define:{'process.env.NODE_ENV':'"production"'}})).outputFiles[0].text;
 await page.setContent('<div id="root"></div>');await page.addScriptTag({content:script});
 await expect(page.getByRole('status')).toContainText('Browser preview unavailable');
 await page.evaluate(()=>{(window as any).remoteBrowserFixture.state.fail=false;});
 await expect(page.getByRole('img')).toBeVisible();await expect(page.getByRole('status')).toHaveCount(0);
 await page.evaluate(()=>{const f=(window as any).remoteBrowserFixture;f.state.tab='b';f.state.fail=true;f.render();});
 await expect(page.getByRole('status')).toBeVisible();await expect(page.getByRole('img')).toHaveCount(0);
 await page.evaluate(()=>{(window as any).remoteBrowserFixture.state.fail=false;});
 await expect(page.getByRole('img')).toBeVisible();
 expect(await page.evaluate(()=>(window as any).remoteBrowserFixture.state.reported)).toEqual([]);
});
