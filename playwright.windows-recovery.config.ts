import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  ...base,
  testMatch: "windows-provider-recovery.desktop.spec.ts",
  timeout: 150000,
  workers: 1,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/windows-provider-recovery.json" }],
  ],
  outputDir: "test-results/windows-provider-recovery",
  use: { actionTimeout: 15000, trace: "retain-on-failure" },
});
