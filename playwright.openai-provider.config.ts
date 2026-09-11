import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "openai-provider.web.spec.ts",
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/openai-provider-web.json" }],
  ],
  outputDir: "test-results/openai-provider-web",
  use: {
    actionTimeout: 15000,
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
  },
});
