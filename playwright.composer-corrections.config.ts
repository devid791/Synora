import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests", testMatch: ["composer-corrections-ui.spec.ts", "live-gpu-status-ui.spec.ts", "remote-browser-ui.spec.ts"],
  workers: 1, timeout: 20000, retries: 0, reporter: "list", outputDir: "test-results/composer-corrections",
  use: { browserName: "chromium", headless: true } });
