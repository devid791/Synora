import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// Every invocation gets its own receipts; never overwrite a previous negative.
const reportDirectory = (process.env.SYNORA_EFFORT_COMPOSER_REPORT_DIR ??=
  mkdtempSync(join(tmpdir(), "synora-effort-composer-")));

export default defineConfig({
  testDir: "./tests",
  testMatch: "effort-composer.web.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 15000,
  expect: { timeout: 3000 },
  reporter: [
    ["list"],
    ["json", { outputFile: resolve(reportDirectory, "report.json") }],
  ],
  outputDir: resolve(reportDirectory, "cases"),
  metadata: {
    scope: "Offline full-App composer regression; no service or inference",
    reportDirectory,
  },
  use: {
    headless: true,
    viewport: { width: 1440, height: 960 },
    launchOptions: { chromiumSandbox: true, args: ["--disable-gpu"] },
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
