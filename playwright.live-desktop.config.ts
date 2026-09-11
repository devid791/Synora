import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (!process.env.SYNORA_TEST_ENDPOINT)
  throw new Error("Live qualification requires explicit SYNORA_TEST_ENDPOINT");
export default defineConfig({
  ...base,
  testMatch: "live.desktop.spec.ts",
  timeout: 180000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/live-desktop.json" }],
  ],
  outputDir: "test-results/live-desktop",
});
