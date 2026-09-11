import { defineConfig } from "@playwright/test";
if (!process.env.SYNORA_TEST_ENDPOINT)
  throw Error("Actual compaction requires an explicit Axiom endpoint");
export default defineConfig({
  testDir: "./tests",
  testMatch: "compaction.web.spec.ts",
  workers: 1,
  timeout: 240000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/compaction-web.json" }],
  ],
  outputDir: "test-results/compaction-web",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
  },
});
