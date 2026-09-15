import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "computer-control.spec.ts",
  workers: 1,
  timeout: 90000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/computer-control.json" }],
  ],
  outputDir: "test-results/computer-control",
  use: { trace: "retain-on-failure" },
});
