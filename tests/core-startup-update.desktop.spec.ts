import { test, expect, _electron } from "@playwright/test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BUNDLED_CORE_VERSION } from "../src/engine/core-runtime";

// Explicit live update acceptance, not part of deterministic unit/default GUI
// suites. Uses the real signed site catalog and real official downloaded Core.
test("packaged app updates Core on startup without a settings click, then restarts on retained runtime", async ({}, info) => {
  const candidate = process.env.SYNORA_TEST_CORE_UPDATE_VERSION;
  expect(candidate).toMatch(/^\d+\.\d+\.\d+$/);
  expect(candidate).not.toBe(BUNDLED_CORE_VERSION);
  expect(process.env.SYNORA_TEST_EXECUTABLE).toBeTruthy();
  const root = await mkdtemp(
    join(await realpath(tmpdir()), "synora-startup-update-"),
  );
  const launch = () =>
    _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: ["--disable-gpu"],
      chromiumSandbox: true,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_DATA_DIR: root },
    });
  let app = await launch();
  const observations: unknown[] = [];
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => !!window.synora);
    const initial = await page.evaluate(() => window.synora.coreUpdateStatus());
    expect(initial.ok && initial.value.automatic).toBe(true);
    expect(initial.ok && initial.value.currentVersion).toBe(
      BUNDLED_CORE_VERSION,
    );
    await expect
      .poll(
        async () => {
          const result = await page.evaluate(() =>
            window.synora.coreUpdateStatus(),
          );
          if (!result.ok) throw Error(result.error.message);
          observations.push(result.value);
          if (result.value.phase === "failed")
            throw Error(result.value.message);
          return result.value.currentVersion;
        },
        { timeout: 450000, intervals: [1000, 3000, 5000] },
      )
      .toBe(candidate);
    const activated = await page.evaluate(() =>
      window.synora.coreUpdateStatus(),
    );
    expect(activated.ok && activated.value.previousVersion).toBe(
      BUNDLED_CORE_VERSION,
    );
    expect(
      activated.ok &&
        activated.value.checks.some((c) => c.includes("settings and history")),
    ).toBe(true);
    await page.evaluate(() => window.synora.coreUpdateAutomatic(false));
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await page.waitForFunction(() => !!window.synora);
    const restarted = await page.evaluate(() =>
      window.synora.coreUpdateStatus(),
    );
    expect(restarted.ok && restarted.value.currentVersion).toBe(candidate);
    expect(restarted.ok && restarted.value.automatic).toBe(false);
    await info.attach("real-core-startup-update", {
      body: Buffer.from(
        JSON.stringify({ initial, activated, restarted, observations }),
      ),
      contentType: "application/json",
    });
  } finally {
    await info.attach("startup-observations", {
      body: Buffer.from(JSON.stringify(observations)),
      contentType: "application/json",
    });
    await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
