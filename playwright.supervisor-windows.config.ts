import { defineConfig } from "@playwright/test";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import {
  frozen,
  executable,
  requireWindowsAdmission,
} from "./tests/fixtures/supervisor-windows-admission";

requireWindowsAdmission(); // No package launch or fallback when handoff is absent.
const parent = resolve("out/live-evidence");
mkdirSync(parent, { recursive: true });
// Config is reloaded in workers; inherit this invocation's fresh directory.
if (!process.env.SYNORA_P13_WINDOWS_EVIDENCE)
  process.env.SYNORA_P13_WINDOWS_EVIDENCE = mkdtempSync(
    join(parent, "supervisor-windows-"),
  );
const evidence = process.env.SYNORA_P13_WINDOWS_EVIDENCE;
const overlay = [
  "tests/supervisor-windows.desktop.spec.ts",
  "playwright.supervisor-windows.config.ts",
  "tests/fixtures/supervisor-windows-admission.ts",
  "tests/fixtures/supervisor-windows-session.ps1",
  "tests/fixtures/supervisor-windows-admission.test.ts",
  "tests/fixtures/supervisor-windows-run.ps1",
].map((file) => ({
  file,
  sha256: createHash("sha256")
    .update(readFileSync(resolve(file)))
    .digest("hex"),
}));
export default defineConfig({
  metadata: {
    executable,
    executable_sha256: frozen.exeSha256,
    asar_sha256: frozen.asarSha256,
    app_commit: frozen.commit,
    original_core_sha256: frozen.coreSha256,
    prepared_home: frozen.prepared,
    qa_overlay: overlay,
    evidence_directory: evidence,
    scope:
      "Windows packaged one-reader P13; explicit handoff required, no setup or simulated results",
  },
  testDir: "./tests",
  testMatch: "supervisor-windows.desktop.spec.ts",
  workers: 1,
  timeout: 300000,
  expect: { timeout: 15000 },
  retries: 0,
  use: { trace: "retain-on-failure", screenshot: "only-on-failure" },
  reporter: [["list"], ["json", { outputFile: join(evidence, "test.json") }]],
  outputDir: join(evidence, "artifacts"),
});
