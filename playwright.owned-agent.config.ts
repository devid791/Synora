import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  testMatch: ["owned-agent.web.spec.ts", "owned-http-mcp.web.spec.ts"],
  workers: 1,
  timeout: 30000,
  reporter: [
    ["list"],
    ["json", { outputFile: "test-results/owned-agent.json" }],
  ],
  outputDir: "test-results/owned-agent",
  use: {
    headless: true,
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
  },
});
