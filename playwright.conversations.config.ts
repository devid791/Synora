import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests", testMatch: ["conversation-sidebar-ui.spec.ts", "welcome-fit-ui.spec.ts"], workers: 1,
  timeout: 20000, retries: 0, reporter: "list", outputDir: "test-results/conversations",
  use: { browserName: "chromium", headless: true } });
