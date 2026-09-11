import { defineConfig } from "@playwright/test";
if (!process.env.SYNORA_TEST_ENDPOINT)
  throw Error("Explicit actual Axiom endpoint required");
export default defineConfig({
  testDir: "./tests",
  testMatch: "fault-recovery.web.spec.ts",
  workers: 1,
  timeout: 300000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/fault-recovery-web.json" }],
  ],
  outputDir: "test-results/fault-recovery-web",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
  },
});
