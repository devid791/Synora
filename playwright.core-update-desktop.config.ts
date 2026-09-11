import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig(base, {
  testMatch: "core-update.desktop.spec.ts",
  timeout: 60000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/core-update-native.json" }],
  ],
  outputDir: "test-results/core-update-native",
});
