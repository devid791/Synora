import { defineConfig } from "@playwright/test";
import base from "./playwright.config";
if (!process.env.SYNORA_TEST_ENDPOINT)
  throw Error("Native image qualification requires an explicit Axiom endpoint");
export default defineConfig({
  ...base,
  testMatch: "images.desktop.spec.ts",
  timeout: 180000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/images-desktop.json" }],
  ],
  outputDir: "test-results/images-desktop",
});
