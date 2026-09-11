import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "anthropic-provider.core.spec.ts",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/anthropic-provider-core.json" }],
  ],
  outputDir: "test-results/anthropic-provider-core",
});
