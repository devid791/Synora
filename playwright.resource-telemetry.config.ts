import { defineConfig } from "@playwright/test";
export default defineConfig({ testDir: "./tests", testMatch: ["resource-telemetry-ui.spec.ts", "gpu-telemetry-ui.spec.ts"], workers: 1,
  timeout: 20000, retries: 0, reporter: "list", outputDir: "test-results/resource-telemetry",
  use: { browserName: "chromium", headless: true } });
