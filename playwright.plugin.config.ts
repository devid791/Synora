import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "core-plugin.web.spec.ts",
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/core-plugin-web.json" }],
  ],
  outputDir: "test-results/core-plugin",
  use: {
    headless: true,
    actionTimeout: 15000,
    navigationTimeout: 15000,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
  },
});
