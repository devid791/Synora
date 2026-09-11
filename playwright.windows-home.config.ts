import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (!process.env.SYNORA_TEST_PREPARED_WINDOWS_QA)
  throw Error(
    "Existing Windows QA home is required; do not provision another sandbox",
  );
export default defineConfig({
  ...base,
  testMatch: "windows-home.desktop.spec.ts",
  timeout: 120000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/windows-home.json" }],
  ],
  outputDir: "test-results/windows-home",
});
