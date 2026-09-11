import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "images-history.desktop.spec.ts",
  timeout: 60000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/images-history-desktop.json" }],
  ],
  outputDir: "test-results/images-history-desktop",
});
