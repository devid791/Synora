import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "core-update.web.spec.ts",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 5000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/core-update-web.json" }],
  ],
  outputDir: "test-results/core-update-web",
  use: {
    headless: true,
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
  },
});
