import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "xai-provider.web.spec.ts",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/xai-provider-web.json" }],
  ],
  outputDir: "test-results/xai-provider-web",
  use: {
    actionTimeout: 15000,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
  },
});
