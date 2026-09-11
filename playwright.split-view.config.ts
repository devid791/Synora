import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "split-view-ui.spec.ts",
  workers: 1,
  timeout: 25000,
  retries: 0,
  reporter: "list",
  outputDir: "test-results/split-view",
  use: { browserName: "chromium", headless: true },
});
