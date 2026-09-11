import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
export default defineConfig({
  metadata: base.metadata,
  testDir: "./tests",
  testMatch: "ui-quality.desktop.spec.ts",
  workers: 1,
  timeout: 90000,
  expect: { timeout: 3000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/ui-quality-desktop.json" }],
  ],
  outputDir: "test-results/ui-quality-desktop",
  use: { trace: "retain-on-failure" },
});
