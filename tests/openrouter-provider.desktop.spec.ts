import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { controlledOpenAi } from "./fixtures/openai-upstream";
import { sha256File } from "../src/engine/core-runtime";

test("OpenRouter native IPC/UI: saved key, real Core command, restart identity, cancellation and 150% layout", async () => {
  const f = await controlledOpenAi({ openrouter: true });
  const providerId =
    process.platform === "win32"
      ? `native-openrouter-${randomUUID()}`
      : "native-openrouter";
  const providerName =
    process.platform === "win32"
      ? `Native OpenRouter ${providerId.slice(-8)}`
      : "Native OpenRouter";
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
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const snapshot = () =>
    page.evaluate(async () => {
      const r = await window.synora.engineSnapshot();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
  const complete = () =>
    expect
      .poll(
        async () => {
          const s = await snapshot();
          return f.errors.length
            ? f.errors
            : s.status === "failed"
              ? s.error
              : s.status;
        },
        { timeout: 30000 },
      )
      .toBe("completed");
  try {
    await launch();
    await nav("Workspace");
    await app!.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, f.workspace);
    if (process.platform === "win32") await nav("New conversation");
    await nav("Add workspace");
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const r = await window.synora.state();
          if (!r.ok) throw Error(r.error.message);
          const c = r.value.conversations[0];
          return r.value.workspaces.find((w) => w.id === c.workspaceId)?.path;
        }),
      )
      .toBe(f.workspace);
    await nav("Models & accounts");
    await nav("Add configuration");
    await page!.getByLabel("Configuration ID").fill(providerId);
    await page!.getByLabel("Configuration name").fill(providerName);
    await page!.getByLabel("Provider adapter").selectOption("openrouter");
    await page!.getByLabel("Configuration endpoint").fill(f.endpoint);
    await page!.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    const auth = () =>
      page.getByRole("region", { name: `Bearer token for ${providerName}` });
    await auth().getByLabel(`Bearer token for ${providerName}`).fill(f.key);
    await auth()
      .getByRole("button", { name: "Save token", exact: true })
      .click();
    await expect(auth()).toContainText("Token saved for this endpoint");
    await expect(
      auth().getByLabel(`Bearer token for ${providerName}`),
    ).toHaveValue("");
    await nav("Settings");
    await page!.getByLabel("Engine provider").selectOption(providerId);
    await nav("Read live model catalog");
    await expect(page!.getByLabel("Engine model")).toHaveValue(
      "fixture/router-model",
    );
    await page!.getByLabel("Model reasoning effort").selectOption("high");
    await nav("Use live OpenRouter");
    await expect(page!.locator(".engine-settings")).toContainText(
      "Current mode: OpenRouter",
    );
    await nav("Workspace");
    await expect(page!.getByLabel("Reasoning profile")).toHaveCount(0);
    await page!
      .getByLabel("Message", { exact: true })
      .fill("Read provider-check.txt and confirm");
    await nav("Send message");
    await complete();
    const first = await snapshot();
    expect(
      first.items.some(
        (v) => v.type === "commandExecution" && v.status === "completed",
      ),
    ).toBe(true);
    expect(first.firstDeltaAt).toBeLessThan(first.completedAt!);
    expect(
      await readFile(join(f.workspace, "provider-check.txt"), "utf8"),
    ).toBe("SYNORA_PROVIDER_FILE_OK\n");
    await app!.close();
    app = undefined;
    await launch();
    await expect(page!.locator(".message.assistant")).toContainText(
      "SYNORA_PROVIDER_OK",
    );
    await page!
      .getByLabel("Message", { exact: true })
      .fill("Confirm after restart");
    await nav("Send message");
    await complete();
    expect((await snapshot()).threadId).toBe(first.threadId);
    expect((await snapshot()).sessionId).toBe(first.sessionId);
    f.state.hold = true;
    await page!
      .getByLabel("Message", { exact: true })
      .fill("Hold for cancellation");
    await nav("Send message");
    await expect.poll(() => f.state.heldRequests).toBe(1);
    await nav("Cancel turn");
    await expect.poll(() => f.state.cancelledStreams).toBe(1);
    await expect
      .poll(async () => (await snapshot()).cleanupPending ?? false)
      .toBe(false);
    f.state.hold = false;
    await page!
      .getByLabel("Message", { exact: true })
      .fill("Resume after cancellation");
    await nav("Send message");
    await complete();
    expect((await snapshot()).sessionId).toBe(first.sessionId);
    await app!.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(1480, 960);
      w.webContents.setZoomFactor(1.5);
    });
    await nav("Model settings");
    await page!.getByLabel("Engine provider").selectOption(providerId);
    await nav("Read live model catalog");
    await expect(page!.getByLabel("Model reasoning effort")).toBeEnabled();
    expect(
      await page!.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await mkdir("test-results/openrouter-provider-native", { recursive: true });
    const png = await app!.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(
      "test-results/openrouter-provider-native/settings-150.png",
      Buffer.from(png, "base64"),
    );
    await nav("Models & accounts");
    await expect(auth()).toContainText("Token saved for this endpoint");
    await auth()
      .getByRole("button", { name: "Remove token", exact: true })
      .click();
    await expect(auth()).toContainText("No token saved");
    const count = f.requests.length;
    const denied = await page!.evaluate(async () => {
      const s = await window.synora.state();
      if (!s.ok) throw Error(s.error.message);
      return window.synora.engineStart(
        s.value.conversations[0].id,
        "Must not reuse removed key",
        "text",
      );
    });
    expect(denied.ok).toBe(false);
    expect(f.requests).toHaveLength(count);
    expect(f.errors).toEqual([]);
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      `out/live-evidence/openrouter-provider-native-${process.platform === "win32" ? "windows" : "linux"}.json`,
      JSON.stringify(
        {
          passed: true,
          scope: `${process.platform} native UI/IPC, original Core, controlled OpenRouter Responses; not public account inference or final installers`,
          coreSha256: await sha256File(f.core),
          threadId: first.threadId,
          sessionId: first.sessionId,
          firstDeltaAt: first.firstDeltaAt,
          completedAt: first.completedAt,
          cancelledStreams: f.state.cancelledStreams,
          toolResult: f.state.toolResult,
          requests: f.requests.map((v) => ({
            path: v.path,
            completed: v.completed,
            authorized: v.authorized,
            model: v.body?.model,
          })),
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    try {
      if (process.platform === "win32" && app && page! && !page.isClosed()) {
        await page.evaluate(() => window.synora.engineCancel());
        const current = await page.evaluate(() => window.synora.state());
        if (!current.ok) throw Error(current.error.message);
        if (current.value.engine.mode !== "simulated") {
          await nav("Settings");
          await nav("Use simulator");
        }
        await expect
          .poll(async () => {
            const r = await page.evaluate(() => window.synora.state());
            return r.ok ? r.value.engine.mode : r.error;
          })
          .toBe("simulated");
      }
    } finally {
      await app?.close();
      await f.close();
    }
  }
});
