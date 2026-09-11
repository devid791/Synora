import { defineConfig } from '@playwright/test';
if (!process.env.SYNORA_TEST_ENDPOINT || !process.env.SYNORA_TEST_SEARCH_URL)
  throw new Error('Live web-tool UI qualification requires explicit Axiom and SearXNG endpoints');
export default defineConfig({
  testDir: './tests', testMatch: 'live-mcp.web.spec.ts', workers: 1, timeout: 180000,
  expect: {timeout:10000}, reporter:[['list'],['json',{outputFile:'test-results/live-mcp-web.json'}]], outputDir:'test-results/live-mcp-web',
  use:{headless:true, viewport:{width:1440,height:1000}, launchOptions:{chromiumSandbox:true,args:['--disable-gpu']},trace:'retain-on-failure'},
});
