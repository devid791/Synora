import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "deepseek-provider.core.spec.ts",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/deepseek-provider-core.json" }],
  ],
  outputDir: "test-results/deepseek-provider-core",
});
