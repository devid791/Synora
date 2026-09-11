import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: "orchestration-panel.web.spec.ts",
  workers: 1,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/orchestration-panel.json" }],
  ],
  outputDir: "test-results/orchestration-panel",
  use: {
    headless: true,
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "wide-1440", use: { viewport: { width: 1440, height: 900 } } },
    { name: "narrow-390", use: { viewport: { width: 390, height: 844 } } },
  ],
});
