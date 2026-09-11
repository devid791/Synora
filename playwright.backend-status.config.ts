import { defineConfig } from "@playwright/test";
import base from "./playwright.live.config";
export default defineConfig({
  ...base,
  testMatch: "backend-status.web.spec.ts",
  timeout: 45000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/backend-status-live.json" }],
  ],
  outputDir: "test-results/backend-status-live",
});
