import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  testMatch: ["settings-ui.spec.ts", "bot-library-ui.spec.ts", "effort-composer.web.spec.ts",
    "panel-layout.web.spec.ts", "engine-pending.web.spec.ts"],
  workers: 1,
  retries: 0,
  maxFailures: 3,
  timeout: 30000,
  expect: { timeout: 5000 },
  reporter: [["list"], ["json", { outputFile: "test-results/control-regression.json" }]],
  outputDir: "test-results/control-regression",
  use: { headless: true, viewport: { width: 1440, height: 960 },
    launchOptions: { chromiumSandbox: true }, trace: "retain-on-failure" },
});
