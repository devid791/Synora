import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "responses-tool-codec.core.spec.ts",
  workers: 1,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/responses-tool-codec-core.json" }],
  ],
  outputDir: "test-results/responses-tool-codec-core",
});
