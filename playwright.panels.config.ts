import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "panel-layout.web.spec.ts",
  workers: 1,
  retries: 0,
  maxFailures: 1,
  timeout: 15000,
  reporter: "list",
  outputDir: "test-results/panel-layout",
  use: { headless: true },
});
