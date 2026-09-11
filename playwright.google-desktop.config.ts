import { defineConfig } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import base from "./playwright.config";
const packaged = !!process.env.SYNORA_TEST_EXECUTABLE;
if (
  packaged &&
  (!process.env.SYNORA_QA_EXPECT_ASAR || !process.env.SYNORA_QA_APP_COMMIT)
)
  throw Error(
    "Packaged Google QA requires explicit frozen ASAR SHA256 and app commit",
  );
if (packaged && !process.env.SYNORA_QA_GOOGLE_RUN_DIR) {
  const parent = resolve("out/live-evidence");
  mkdirSync(parent, { recursive: true });
  process.env.SYNORA_QA_GOOGLE_RUN_DIR = mkdtempSync(
    join(parent, "google-packaged-"),
  );
}
const run = process.env.SYNORA_QA_GOOGLE_RUN_DIR;
const hash = (file: string) =>
  createHash("sha256").update(readFileSync(file)).digest("hex");
const overlay = [
  "tests/google-oauth.desktop.spec.ts",
  "playwright.google-desktop.config.ts",
  "tests/fixtures/google-packaged-peer.cjs",
  "tests/fixtures/google-packaged-peer.test.cjs",
  "tests/fixtures/google-packaged-linux.mjs",
].map((file) => ({ file, sha256: hash(resolve(file)) }));
export default defineConfig({
  metadata: {
    ...base.metadata,
    scope: packaged
      ? "Actual package; controlled Google HTTP peer/browser, NOT public consent/inference"
      : "Development bootstrap; NOT packaged",
    app_commit: process.env.SYNORA_QA_APP_COMMIT ?? null,
    expected_asar_sha256: process.env.SYNORA_QA_EXPECT_ASAR ?? null,
    executable_sha256: packaged
      ? hash(process.env.SYNORA_TEST_EXECUTABLE!)
      : null,
    qa_overlay: overlay,
    evidence_directory: run ?? null,
  },
  testDir: "./tests",
  testMatch: "google-oauth.desktop.spec.ts",
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: run
          ? join(run, "test.json")
          : "test-results/google-oauth-desktop.json",
      },
    ],
  ],
  outputDir: run ? join(run, "artifacts") : "test-results/google-oauth-desktop",
});
