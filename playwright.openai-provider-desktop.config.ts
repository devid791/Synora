import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "openai-provider.desktop.spec.ts",
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/openai-provider-native.json" }],
  ],
  outputDir: "test-results/openai-provider-native",
  use: { actionTimeout: 15000, trace: "retain-on-failure" },
});
