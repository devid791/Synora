import { test, expect, _electron } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { tmpdir } from "node:os";
import { qualifyImageVisual } from "./fixtures/image-native-visual";

test("Read-only native image history: exact prior completed session and uncropped native pixels", async () => {
  const prior = JSON.parse(
    await readFile("out/live-evidence/image-native-actual.json", "utf8"),
  );
  expect(prior.passed).toBe(true);
  expect(dirname(resolve(prior.dir))).toBe(resolve(tmpdir()));
  expect(basename(prior.dir)).toMatch(/^synora-image-native-[A-Za-z0-9]+$/);
  const app = await _electron.launch({
    executablePath: process.env.SYNORA_TEST_EXECUTABLE,
    args: process.env.SYNORA_TEST_EXECUTABLE
      ? ["--disable-gpu"]
      : [".", "--disable-gpu"],
    chromiumSandbox: true,
    cwd: process.cwd(),
    env: { ...process.env, SYNORA_DATA_DIR: join(prior.dir, "state") },
  });
  const errors: string[] = [];
  try {
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    const snapshot = () =>
      page.evaluate(async () => {
        const r = await window.synora.engineSnapshot();
        if (!r.ok) throw Error(r.error.message);
        return r.value;
      });
    await expect
      .poll(async () => (await snapshot()).status, { timeout: 30000 })
      .toBe("completed");
    const restored = await snapshot();
    expect(restored.threadId).toBe(prior.completed.threadId);
    expect(restored.sessionId).toBe(prior.completed.sessionId);
    expect(restored.turnId).toBe(prior.completed.turnId);
    expect(restored.backendRequests).toHaveLength(
      prior.restored.backendRequests.length,
    );
    await expect(page.locator(".message.assistant").last()).toContainText(
      new RegExp(prior.color, "i"),
    );
    const visual = await qualifyImageVisual(
      app,
      page,
      "test-results/images-history-desktop/actual-image-150.png",
    );
    expect(errors).toEqual([]);
    await writeFile(
      "out/live-evidence/image-native-visual.json",
      JSON.stringify(
        {
          passed: true,
          source: "out/live-evidence/image-native-actual.json",
          visual,
          restoredThreadId: restored.threadId,
          turnId: restored.turnId,
          errors,
          scope:
            "Read-only reopen and native pixel capture of the already completed image request; no new inference",
        },
        null,
        2,
      ),
    );
  } finally {
    await app.close();
  }
});
