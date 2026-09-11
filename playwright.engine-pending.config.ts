import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "@playwright/test";

const reportDirectory = (process.env.SYNORA_ENGINE_PENDING_REPORT_DIR ??=
  mkdtempSync(join(tmpdir(), "synora-engine-pending-")));
export default defineConfig({
  testDir: "./tests",
  testMatch: "engine-pending.web.spec.ts",
  workers: 1,
  retries: 0,
  fullyParallel: false,
  timeout: 20000,
  expect: { timeout: 3000 },
  reporter: [
    ["list"],
    ["json", { outputFile: join(reportDirectory, "report.json") }],
  ],
  outputDir: join(reportDirectory, "cases"),
  metadata: {
    reportDirectory,
    scope:
      "Offline full-App pending-operation regression; no service/Core/inference",
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
