import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { readFile, writeFile, realpath, mkdir } from "node:fs/promises";
import { dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";

test("Native IPC compaction on the qualified owned web conversation, retained draft and native cold recovery", async ({}, testInfo) => {
  const prior = JSON.parse(
    await readFile("out/live-evidence/compaction-actual.json", "utf8"),
  );
  expect(prior.passed).toBe(true);
  expect(await realpath(dirname(resolve(prior.dir)))).toBe(
    await realpath(tmpdir()),
  );
  expect(basename(prior.dir)).toMatch(/^synora-compact-ui-[A-Za-z0-9]+$/);
  let app: ElectronApplication | undefined, page: Page;
  const errors: string[] = [];
  const launch = async () => {
    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: process.env.SYNORA_TEST_EXECUTABLE
        ? ["--disable-gpu"]
        : [".", "--disable-gpu"],
      chromiumSandbox: true,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_DATA_DIR: prior.dir },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    // Persisted completed state is not evidence that the original Core resume
    // actually succeeded. Wait for the owned live transport on each launch.
    await expect
      .poll(
        async () => {
          const s = await snapshot();
          if (s.error) throw Error(JSON.stringify(s.error));
          return s.connection;
        },
        { timeout: 30000 },
      )
      .toBe("live");
  };
  const snapshot = () =>
    page.evaluate(async () => {
      const r = await window.synora.engineSnapshot();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
  const state = () =>
    page.evaluate(async () => {
      const r = await window.synora.state();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
  const complete = () =>
    expect
      .poll(
        async () => {
          const s = await snapshot();
          if (s.status === "failed") throw Error(JSON.stringify(s.error));
          return s.status;
        },
        { timeout: 120000 },
      )
      .toBe("completed");
  try {
    await launch();
    await complete();
    const initial = await snapshot();
    expect(initial.sessionId).toBe(prior.first.sessionId);
    // This same-host history already contains earlier genuine compactions.
    // Address the recorded original item, not every same-labelled history card.
    const original = initial.compactions?.find((c) => c.id === prior.record.id);
    expect(original?.status).toBe("completed");
    await expect(
      page!
        .locator(`[data-item-id="${prior.record.id}"]`)
        .getByRole("status"),
    ).toHaveText("completed");
    const before = (await state()).conversations[0];
    await page!
      .getByLabel("Message", { exact: true })
      .fill("Native unsent draft survives context compaction.");
    await page!
      .getByRole("button", { name: "Compact context", exact: true })
      .click();
    await expect
      .poll(async () => (await snapshot()).turnId)
      .not.toBe(initial.turnId);
    await complete();
    const compacted = await snapshot(),
      after = (await state()).conversations[0];
    expect(compacted.threadId).toBe(prior.first.threadId);
    expect(compacted.sessionId).toBe(prior.first.sessionId);
    const record = compacted.compactions?.find(
      (c) => c.turnId === compacted.turnId,
    );
    expect(record?.status).toBe("completed");
    for (const m of before.messages) expect(after.messages).toContainEqual(m);
    expect(after.draft).toBe(
      "Native unsent draft survives context compaction.",
    );
    expect(after.compactions).toHaveLength(before.compactions!.length + 1);
    await app!.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(1280, 1000);
      win.webContents.setZoomFactor(1.5);
    });
    const card = page!.locator(`[data-item-id="${record!.id}"]`);
    await card.scrollIntoViewIfNeeded();
    await expect(card.getByRole("status")).toHaveText("completed");
    const geometry = await card.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left,
        right: r.right,
        width: innerWidth,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(geometry.left).toBeGreaterThanOrEqual(0);
    expect(geometry.right).toBeLessThanOrEqual(geometry.width);
    expect(geometry.overflow).toBe(false);
    await expect(card.getByRole("status")).toBeInViewport();
    await page!.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await page!.waitForTimeout(150);
    await mkdir("test-results/compaction-desktop", { recursive: true });
    const png = await app!.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(
      "test-results/compaction-desktop/compaction-150.png",
      Buffer.from(png, "base64"),
    );
    await app!.close();
    app = undefined;
    await launch();
    await complete();
    const restored = await snapshot();
    expect(restored.sessionId).toBe(compacted.sessionId);
    expect(restored.threadId).toBe(compacted.threadId);
    expect(restored.turnId).toBe(compacted.turnId);
    expect((await state()).conversations[0].compactions).toContainEqual(record);
    await expect(page!.getByLabel("Message", { exact: true })).toHaveValue(
      after.draft,
    );
    expect(errors).toEqual([]);
    await writeFile(
      "out/live-evidence/compaction-native-actual.json",
      JSON.stringify(
        {
          passed: true,
          metadata: testInfo.config.metadata,
          dir: prior.dir,
          initial,
          compacted,
          restored,
          record,
          geometry,
          errors,
          scope: process.env.SYNORA_TEST_EXECUTABLE
            ? "Actual identified package IPC/Core/Axiom compaction and live cold recovery of same-host owned QA history; no other-platform or context-saturation claim"
            : "Development native IPC/Core/Axiom compaction and live cold recovery; not a packaged/platform-wide pass",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      "out/live-evidence/compaction-native-failure.json",
      JSON.stringify(
        {
          dir: prior.dir,
          error: String(error),
          snapshot: await snapshot().catch((e) => String(e)),
          errors,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await app?.close();
  }
});
