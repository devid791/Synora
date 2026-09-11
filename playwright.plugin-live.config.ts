import { defineConfig } from "@playwright/test";
if (!process.env.SYNORA_TEST_ENDPOINT)
  throw Error(
    "Explicit Axiom endpoint required for actual plugin tool qualification",
  );
export default defineConfig({
  testDir: "./tests",
  testMatch: "core-plugin.live.web.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 210000,
  expect: { timeout: 15000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/core-plugin-live-web.json" }],
  ],
  outputDir: "test-results/core-plugin-live-web",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
  },
});
