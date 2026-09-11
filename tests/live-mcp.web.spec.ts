import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startWebService } from '../src/web/server';

test('Live UI mounts native web tools, shows actual calls/results/catalog, restores IDs and invalidates disconnected configuration', async ({page}) => {
  const dir = await mkdtemp(join(tmpdir(), 'synora-live-mcp-ui-'));
  const workspace = join(dir,'workspace'); await mkdir(workspace);
  const server = await startWebService({storePath:join(dir,'state.sqlite'), assets:resolve('out/web/ui')});
  const errors:string[]=[];
  page.on('pageerror', e=>errors.push(e.message));
  const nav = (name:string) => page.getByRole('button',{name,exact:true}).click();
  try {
    await page.goto(server.url);
    await nav('Add workspace'); await page.getByLabel('Service folder').fill(workspace); await nav('Open folder');
    await nav('Models & accounts'); await nav('Add configuration');
    await page.getByLabel('Configuration ID').fill('live-axiom'); await page.getByLabel('Configuration name').fill('Live Axiom');
    await page.getByLabel('Configuration endpoint').fill(process.env.SYNORA_TEST_ENDPOINT!); await page.getByLabel('Enable configuration').check(); await nav('Save configuration');
    await nav('Connectors'); await nav('Add configuration');
    await page.getByLabel('Configuration ID').fill('live-web'); await page.getByLabel('Configuration name').fill('Live web qualification');
    await page.getByLabel('Integration executor').selectOption('searxng');
    await page.getByLabel('Configuration endpoint').fill(process.env.SYNORA_TEST_SEARCH_URL!);
    await expect(page.getByLabel('Declared tools')).toBeDisabled();
    await page.getByLabel('Enable configuration').check(); await nav('Save configuration');
    const card=page.locator('article.card').filter({hasText:'Live web qualification'});
    await expect(card).toContainText('Not connected'); await expect(card).toContainText('0 mounted tools');
    await nav('Settings'); await page.getByLabel('Engine provider').selectOption('live-axiom'); await nav('Read live model catalog'); await nav('Use live Axiom');
    await nav('Workspace');
    await page.getByLabel('Message',{exact:true}).fill('Use your mounted web_search tool to search IANA reserved example domains. Then use web_fetch to read an IANA URL from those search results. No shell or other network tools. Reply with one sentence about the purpose of the domains and the fetched URL, based on the actual tool results.');
    await nav('Send message');
    await expect.poll(()=>server.service.engine.snapshot().status,{timeout:120000}).toBe('completed');
    const completed=server.service.engine.snapshot();
    const calls=completed.items.filter(i=>i.type==='mcpToolCall');
    expect(calls.some(c=>c.tool==='web_search' && c.status==='completed' && !c.error)).toBe(true);
    expect(calls.some(c=>c.tool==='web_fetch' && c.status==='completed' && !c.error)).toBe(true);
    for (const call of calls) {
      const row=page.locator(`[data-item-id="${call.id}"]`);
      await expect(row).toHaveCount(1); await expect(row).toContainText(call.tool); await expect(row).toContainText('Live');
      await expect(row).toContainText('Tool result · untrusted content');
    }
    await page.screenshot({path:'test-results/live-mcp-web/actual-tools.png'});
    await nav('Connectors'); await expect(card).toContainText('connected'); await expect(card).toContainText('2 mounted tools');
    await card.getByText('Core tool catalog',{exact:true}).click();
    await expect(card.getByText('web_search',{exact:true})).toBeVisible(); await expect(card.getByText('web_fetch',{exact:true})).toBeVisible();
    await page.screenshot({path:'test-results/live-mcp-web/actual-catalog.png'});
    await nav('Workspace'); await page.reload();
    await expect.poll(()=>server.service.engine.snapshot().status,{timeout:30000}).toBe('completed');
    expect(server.service.engine.snapshot().sessionId).toBe(completed.sessionId);
    for (const call of calls) await expect(page.locator(`[data-item-id="${call.id}"]`)).toHaveCount(1);
    await nav('Connectors'); await card.getByRole('button',{name:'Edit',exact:true}).click();
    await page.getByLabel('Enable configuration').uncheck(); await nav('Save configuration');
    await expect(card).toContainText('Disabled'); await expect(card).toContainText('0 mounted tools');
    expect(errors).toEqual([]);
    await mkdir('out/live-evidence',{recursive:true});
    await writeFile('out/live-evidence/web-mcp-ui.json',JSON.stringify({dir,completed,calls,errors},null,2));
  } finally {await page.goto('about:blank'); await server.close();}
});
