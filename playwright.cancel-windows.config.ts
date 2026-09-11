import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (
  !process.env.SYNORA_TEST_EXECUTABLE ||
  !process.env.SYNORA_TEST_ENDPOINT ||
  !process.env.SYNORA_TEST_PREPARED_WINDOWS_QA
)
  throw Error(
    "Explicit Windows package, Axiom endpoint and prepared owned state required",
  );
export default defineConfig({
  ...base,
  testMatch: "cancel-windows.desktop.spec.ts",
  timeout: 180000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/cancel-windows.json" }],
  ],
  outputDir: "test-results/cancel-windows",
});
