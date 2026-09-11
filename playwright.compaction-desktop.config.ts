import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "compaction.desktop.spec.ts",
  timeout: 150000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/compaction-desktop.json" }],
  ],
  outputDir: "test-results/compaction-desktop",
});
