import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig(base, {
  testMatch: "core-startup-update.desktop.spec.ts",
  timeout: 540000,
  workers: 1,
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/core-startup-update.json" }],
  ],
  outputDir: "test-results/core-startup-update",
});
