import { defineConfig } from "@playwright/test";
if (!process.env.SYNORA_SUPERVISOR_EVIDENCE)
  throw Error("Explicit completed owned supervisor evidence required");
export default defineConfig({
  testDir: "./tests",
  testMatch: "orchestration-history.web.spec.ts",
  workers: 1,
  timeout: 90000,
  expect: { timeout: 10000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/orchestration-history-web.json" }],
  ],
  outputDir: "test-results/orchestration-history-web",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
  },
});
