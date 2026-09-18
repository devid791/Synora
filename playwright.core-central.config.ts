import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests", testMatch: "compatible-provider.core.spec.ts",
  workers: 1, retries: 0, timeout: 120000, expect: { timeout: 15000 },
  reporter: [["json", { outputFile: "out/core-central/runtime-raw.json" }]],
  outputDir: "out/core-central/test-results",
});
