import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: ".", testMatch: "bot-library-ui.spec.ts", workers: 1, retries: 0,
  timeout: 15000, reporter: "list", outputDir: "../test-results/bot-library-ui",
  use: { headless: true },
});
