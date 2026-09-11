import { defineConfig } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
const executable = process.env.SYNORA_TEST_EXECUTABLE;
export default defineConfig({
  metadata: {
    executable: executable ?? null,
    asar_sha256: executable
      ? createHash("sha256")
          .update(
            readFileSync(
              join(
                dirname(executable),
                process.platform === "darwin"
                  ? "../Resources/app.asar"
                  : "resources/app.asar",
              ),
            ),
          )
          .digest("hex")
      : null,
  },
  testDir: "./tests",
  testMatch: "desktop.spec.ts",
  workers: 1,
  timeout: 45000,
  expect: { timeout: 10000 },
  reporter: [["list"], ["json", { outputFile: "test-results/desktop.json" }]],
  outputDir: "test-results/desktop",
  use: { trace: "retain-on-failure" },
});
