import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: "xai-provider.desktop.spec.ts",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/xai-provider-native.json" }],
  ],
  outputDir: "test-results/xai-provider-native",
  use: { actionTimeout: 15000, trace: "retain-on-failure" },
});
