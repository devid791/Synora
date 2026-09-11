import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "catalog-discovery.web.spec.ts",
  workers: 1,
  timeout: 15000,
  retries: 0,
  reporter: "list",
  outputDir: process.env.SYNORA_TEST_OUTPUT ?? "test-results/catalog-discovery",
  use: { browserName: "chromium", headless: true },
});
