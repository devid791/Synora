import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: "plugin-directory-ui.spec.ts", workers: 1,
  timeout: 15000, retries: 0, reporter: "list", outputDir: "test-results/plugin-directory",
  use: { browserName: "chromium", headless: true },
});
