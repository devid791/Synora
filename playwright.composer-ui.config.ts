import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "composer-ui.web.spec.ts",
  workers: 2,
  retries: 0,
  maxFailures: 1,
  timeout: 12000,
  reporter: "list",
  outputDir: "test-results/composer-ui",
  use: { headless: true },
});
