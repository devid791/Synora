import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: "openrouter-provider.desktop.spec.ts",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/openrouter-desktop.json" }],
  ],
  outputDir: "test-results/openrouter-desktop",
});
