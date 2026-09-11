import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: ["oauth.web.spec.ts", "provider-token.web.spec.ts"],
  workers: 1,
  timeout: 60000,
  expect: { timeout: 15000 },
  reporter: [["list"], ["json", { outputFile: "test-results/oauth-web.json" }]],
  outputDir: "test-results/oauth-web",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
  },
});
