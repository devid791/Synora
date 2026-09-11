import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "workspace-controls.web.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 15000,
  reporter: "list",
  outputDir:
    process.env.SYNORA_TEST_OUTPUT ?? "test-results/workspace-controls",
  use: { browserName: "chromium", headless: true },
});
