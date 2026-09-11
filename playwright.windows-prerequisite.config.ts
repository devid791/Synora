import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (
  process.platform !== "win32" ||
  !process.env.SYNORA_TEST_EXECUTABLE ||
  !process.env.SYNORA_TEST_ENDPOINT
)
  throw new Error(
    "This check requires the actual packaged Windows application and explicit catalog endpoint",
  );
export default defineConfig({
  ...base,
  testMatch: "windows-prerequisite.desktop.spec.ts",
  timeout: 90000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/windows-prerequisite.json" }],
  ],
  outputDir: "test-results/windows-prerequisite",
});
