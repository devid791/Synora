import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "anthropic-provider.web.spec.ts",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    headless: true,
    viewport: { width: 1440, height: 960 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/anthropic-web.json" }],
  ],
  outputDir: "test-results/anthropic-web",
});
