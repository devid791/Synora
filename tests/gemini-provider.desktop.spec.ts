import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { controlledGemini } from "./fixtures/gemini-upstream";
import { geminiUiWorkflow } from "./fixtures/gemini-ui-workflow";
import { sha256File } from "../src/engine/core-runtime";
test("Gemini native IPC/UI: signed tool round-trip, cold restart, cancellation, credential deletion and 150% layout", async () => {
  expect(["linux", "darwin", "win32"]).toContain(process.platform);
  const platform =
    process.platform === "win32"
      ? "windows"
      : process.platform === "darwin"
        ? "macos"
        : "linux";
  const suffix = process.platform === "win32" ? randomUUID() : undefined;
  const provider = suffix
    ? {
        id: `gemini-native-${suffix}`,
        name: `Owned Gemini API ${suffix.slice(-8)}`,
      }
    : undefined;
  // The shared base must admit actual network isolation and, on Windows,
  // the existing prepared Core home before Electron or the upstream starts.
  const f = await controlledGemini();
  let app: ElectronApplication | undefined, page: Page;
  const errors: string[] = [];
  let result: Awaited<ReturnType<typeof geminiUiWorkflow>>;
  const launch = async () => {
    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: process.env.SYNORA_TEST_EXECUTABLE
        ? ["--disable-gpu"]
        : [".", "--disable-gpu"],
      cwd: process.cwd(),
      chromiumSandbox: true,
      env: {
        ...process.env,
        SYNORA_DATA_DIR: f.dataRoot,
        SYNORA_CODEX_BINARY: f.wrapper,
      },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(true);
  };
  try {
    await launch();
    result = await geminiUiWorkflow({
      fixture: f,
      provider,
      page: () => page,
      snapshot: () =>
        page.evaluate(async () => {
          const r = await window.synora.engineSnapshot();
          if (!r.ok) throw Error(r.error.message);
          return r.value;
        }),
      addWorkspace: async () => {
        await page
          .getByRole("button", { name: "Workspace", exact: true })
          .click();
        const previous =
          process.platform === "win32"
            ? await page.evaluate(async () => {
                const r = await window.synora.state();
                if (!r.ok) throw Error(r.error.message);
                return r.value.conversations.map(({ id, workspaceId }) => ({
                  id,
                  workspaceId,
                }));
              })
            : [];
        await app!.evaluate(({ dialog }, path) => {
          dialog.showOpenDialog = (async () => ({
            canceled: false,
            filePaths: [path],
          })) as typeof dialog.showOpenDialog;
        }, f.workspace);
        // Add workspace associates the current conversation: never rebind an
        // existing prepared-home QA conversation to this disposable workspace.
        if (process.platform === "win32")
          await page
            .getByRole("button", { name: "New conversation", exact: true })
            .click();
        await page
          .getByRole("button", { name: "Add workspace", exact: true })
          .click();
        await expect
          .poll(() =>
            page.evaluate(async () => {
              const r = await window.synora.state();
              if (!r.ok) throw Error(r.error.message);
              const c = r.value.conversations[0];
              return r.value.workspaces.find((w) => w.id === c.workspaceId)
                ?.path;
            }),
          )
          .toBe(f.workspace);
        if (process.platform === "win32") {
          const current = await page.evaluate(async () => {
            const r = await window.synora.state();
            if (!r.ok) throw Error(r.error.message);
            return r.value.conversations.map(({ id, workspaceId }) => ({
              id,
              workspaceId,
            }));
          });
          expect(previous.some((c) => c.id === current[0].id)).toBe(false);
          for (const conversation of previous)
            expect(current.find((c) => c.id === conversation.id)).toEqual(
              conversation,
            );
        }
      },
      restart: async () => {
        await app!.close();
        app = undefined;
        await launch();
      },
      capture: async (token) => {
        await app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5),
        );
        await page.waitForTimeout(150);
        const remove = token.getByRole("button", {
          name: "Remove token",
          exact: true,
        });
        await remove.scrollIntoViewIfNeeded();
        await expect(remove).toBeInViewport();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        // Capture the painted native frame after scrolling, not the previous
        // compositor frame. This matches the existing later-provider fixtures.
        await page.waitForTimeout(150);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        await mkdir("out/live-evidence/gemini-ui", { recursive: true });
        const pixels = await app!.evaluate(async ({ BrowserWindow }) =>
          (await BrowserWindow.getAllWindows()[0].capturePage())
            .toPNG()
            .toString("base64"),
        );
        await writeFile(
          `out/live-evidence/gemini-ui/${platform}-150.png`,
          Buffer.from(pixels, "base64"),
        );
      },
    });
  } finally {
    try {
      if (process.platform === "win32" && app && page! && !page.isClosed()) {
        // Match the prepared-home OpenAI/xAI/OpenRouter teardown. Never reset
        // the sandbox, delete historical conversations, or leave live mode.
        const cancelled = await page.evaluate(() =>
          window.synora.engineCancel(),
        );
        if (!cancelled.ok) throw Error(cancelled.error.message);
        const current = await page.evaluate(() => window.synora.state());
        if (!current.ok) throw Error(current.error.message);
        if (current.value.engine.mode !== "simulated") {
          await page
            .getByRole("button", { name: "Settings", exact: true })
            .click();
          await page
            .getByRole("button", { name: "Use simulator", exact: true })
            .click();
        }
        await expect
          .poll(async () => {
            const r = await page.evaluate(() => window.synora.state());
            return r.ok ? r.value.engine.mode : r.error;
          })
          .toBe("simulated");
      }
    } finally {
      try {
        await app?.close();
      } finally {
        await f.close();
      }
    }
  }
  // A success receipt is written only after prepared-home and process cleanup.
  expect(errors).toEqual([]);
  await writeFile(
    `out/live-evidence/gemini-provider-native-${platform}.json`,
    JSON.stringify(
      {
        passed: true,
        scope: process.env.SYNORA_TEST_EXECUTABLE
          ? `Packaged ${platform} UI/IPC, original Core, controlled Gemini; not public inference or full release qualification`
          : `Native ${platform} development UI/IPC, original Core, controlled Gemini; not public inference or final installer`,
        platform: process.platform,
        executable: process.env.SYNORA_TEST_EXECUTABLE ?? null,
        executableSha256: process.env.SYNORA_TEST_EXECUTABLE
          ? await sha256File(process.env.SYNORA_TEST_EXECUTABLE)
          : null,
        pixels: `out/live-evidence/gemini-ui/${platform}-150.png`,
        pixelsSha256: await sha256File(
          `out/live-evidence/gemini-ui/${platform}-150.png`,
        ),
        coreSha256: await sha256File(f.core),
        ...result,
        uiErrors: errors,
      },
      null,
      2,
    ),
  );
});
