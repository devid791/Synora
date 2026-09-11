import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "ui-quality.web.spec.ts",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 3000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/ui-quality-web.json" }],
  ],
  outputDir: "test-results/ui-quality-web",
  use: {
    headless: true,
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
  },
});
