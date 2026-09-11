import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (!process.env.SYNORA_TEST_EXECUTABLE || !process.env.SYNORA_TEST_ENDPOINT)
  throw Error("Explicit packaged executable and Axiom endpoint required");
export default defineConfig({
  ...base,
  testMatch: "cancel.desktop.spec.ts",
  timeout: 150000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/cancel-native.json" }],
  ],
  outputDir: "test-results/cancel-native",
});
