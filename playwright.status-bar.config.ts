import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: ["status-bar-ui.spec.ts"],
  workers: 1,
  timeout: 20000,
  retries: 0,
  reporter: "list",
  outputDir: "test-results/status-bar",
  use: { browserName: "chromium", headless: true },
});
