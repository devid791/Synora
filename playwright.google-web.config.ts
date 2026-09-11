import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: "google-oauth.web.spec.ts",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: {
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    headless: true,
    viewport: { width: 1440, height: 960 },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/google-oauth-web.json" }],
  ],
  outputDir: "test-results/google-oauth-web",
});
