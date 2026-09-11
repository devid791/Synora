import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "interaction-ui.web.spec.ts",
  workers: 1,
  timeout: 30000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/interaction-ui.json" }],
  ],
  outputDir: "test-results/interaction-ui",
  use: {
    headless: true,
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
  },
});
