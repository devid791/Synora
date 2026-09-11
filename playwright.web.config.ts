import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
export default defineConfig({
  metadata: {
    web_server_sha256: createHash("sha256")
      .update(readFileSync("out/web/server.mjs"))
      .digest("hex"),
  },
  testDir: "./tests",
  testMatch: "web.spec.ts",
  workers: 1,
  timeout: 60000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["json", { outputFile: "test-results/web.json" }]],
  outputDir: "test-results/web",
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    trace: "retain-on-failure",
  },
});
