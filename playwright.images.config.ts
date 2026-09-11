import { defineConfig } from "@playwright/test";
if (!process.env.SYNORA_TEST_ENDPOINT)
  throw Error(
    "Actual vision qualification requires an explicit Axiom endpoint",
  );
export default defineConfig({
  testDir: "./tests",
  testMatch: "images.web.spec.ts",
  workers: 1,
  timeout: 180000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/images-web.json" }],
  ],
  outputDir: "test-results/images-web",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
  },
});
