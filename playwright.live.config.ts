import { defineConfig } from "@playwright/test";
if (!process.env.SYNORA_TEST_ENDPOINT)
  throw new Error("Live qualification requires explicit SYNORA_TEST_ENDPOINT");
export default defineConfig({
  testDir: "./tests",
  testMatch: "live.web.spec.ts",
  workers: 1,
  timeout: 180000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["json", { outputFile: "test-results/live-web.json" }]],
  outputDir: "test-results/live-web",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
  },
});
