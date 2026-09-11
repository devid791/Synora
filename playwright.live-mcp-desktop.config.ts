import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (
  !process.env.SYNORA_TEST_EXECUTABLE ||
  !process.env.SYNORA_TEST_ENDPOINT ||
  !process.env.SYNORA_TEST_SEARCH_URL
)
  throw Error(
    "Explicit packaged executable, Axiom endpoint and configured search endpoint are required",
  );
export default defineConfig({
  ...base,
  testMatch: "live-mcp.desktop.spec.ts",
  timeout: 180000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/live-mcp-native.json" }],
  ],
  outputDir: "test-results/live-mcp-native",
});
