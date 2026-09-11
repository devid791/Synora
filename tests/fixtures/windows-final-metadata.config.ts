import { defineConfig } from "@playwright/test";
import base from "../../playwright.config";

if (process.platform !== "win32" || !process.env.SYNORA_TEST_EXECUTABLE)
  throw Error(
    "Windows final metadata requires the actual packaged Windows EXE",
  );

export default defineConfig({
  ...base,
  testDir: "..",
  testMatch: "windows-final-metadata.desktop.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/windows-final-metadata.json" }],
  ],
  outputDir: "../../test-results/windows-final-metadata",
  use: { trace: "retain-on-failure" },
});
