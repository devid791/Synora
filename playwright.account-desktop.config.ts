import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testDir: "./tests",
  testMatch: "core-account.desktop.spec.ts",
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/account-native.json" }],
  ],
  outputDir: "test-results/account-native",
});
