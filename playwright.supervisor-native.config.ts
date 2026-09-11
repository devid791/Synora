import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (
  !process.env.SYNORA_TEST_EXECUTABLE ||
  !process.env.SYNORA_TEST_ENDPOINT ||
  process.env.SYNORA_ONE_AGENT_AUTHORIZED !== "1"
)
  throw Error(
    "Explicit package, endpoint and one-worker authorization required",
  );
export default defineConfig({
  ...base,
  testMatch: "supervisor-native.desktop.spec.ts",
  timeout: 240000,
  expect: { timeout: 15000 },
  retries: 0,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/supervisor-native.json" }],
  ],
  outputDir: "test-results/supervisor-native",
});
