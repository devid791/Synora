// Original packaged/development Electron IPC and original Core; Responses is
// controlled. Requires OS network namespace with only loopback, no public API.
import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { controlledOpenAi } from "./fixtures/openai-upstream";
import { sha256File } from "../src/engine/core-runtime";
import type { EngineSnapshot } from "../src/shared/contracts";

test("Native original Core provider: account namespace, real command, cold resume, interrupt cleanup, model UI and logout", async () => {
  const fixture = await controlledOpenAi();
  const { directory, workspace, wrapper, key, errors, requests, state } =
    fixture;
  const providerId =
    process.platform === "win32"
      ? `native-openai-${randomUUID()}`
      : "native-openai";
  let app: ElectronApplication | undefined, page: Page | undefined;
  let last: EngineSnapshot | undefined;
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
        SYNORA_DATA_DIR: fixture.dataRoot,
        SYNORA_CODEX_BINARY: wrapper,
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
    return page;
  };
  const nav = (name: string) =>
    page!.getByRole("button", { name, exact: true }).click();
  const snapshot = async () => {
    last = await page!.evaluate(async () => {
      const r = await window.synora.engineSnapshot();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
    return last;
  };
  const complete = async () => {
    await expect
      .poll(
        async () => {
          const s = await snapshot();
          if (s.status === "failed") throw Error(JSON.stringify(s.error));
          return errors.length ? errors : s.status;
        },
        { timeout: 30000 },
      )
      .toBe("completed");
  };
  try {
    page = await launch();
    await nav("Workspace");
    await app!.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, workspace);
    if (process.platform === "win32") await nav("New conversation");
    await nav("Add workspace");
    await expect
      .poll(async () =>
        page!.evaluate(async () => {
          const r = await window.synora.state();
          if (!r.ok) throw Error(r.error.message);
          const c = r.value.conversations[0];
          return r.value.workspaces.find((w) => w.id === c.workspaceId)?.path;
        }),
      )
      .toBe(workspace);
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill(providerId);
    await page.getByLabel("Configuration name").fill("Owned native OpenAI");
    await page.getByLabel("Provider adapter").selectOption("openai");
    await expect(page.getByLabel("Configuration endpoint")).toHaveValue(
      "https://api.openai.com/v1",
    );
    await expect(page.getByLabel("Configuration endpoint")).toHaveAttribute(
      "readonly",
      "",
    );
    await expect(page.getByLabel("Declared tools")).toBeDisabled();
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    let account = page.getByRole("article", { name: "OpenAI account" });
    await account.getByLabel("OpenAI sign-in method").selectOption("apiKey");
    await account.getByLabel("OpenAI API key", { exact: true }).fill(key);
    await account.getByRole("button", { name: "Save OpenAI API key" }).click();
    await expect(account).toContainText("Core sign-in completed");
    await expect(
      account.getByLabel("OpenAI API key", { exact: true }),
    ).toHaveValue("");
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption(providerId);
    await nav("Read live model catalog");
    await expect(page.getByLabel("Engine model")).toBeEnabled();
    const catalog = await page.evaluate(async (id) => {
      const r = await window.synora.engineModels(id);
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    }, providerId);
    const chosen = catalog.find(
      (m) => m.coreModel?.isDefault && m.reasoning_efforts.includes("high"),
    )!;
    expect(chosen).toBeTruthy();
    expect(chosen.context_window).toBeNull();
    expect(chosen.context_window_options).toEqual([]);
    await page.getByLabel("Engine model").selectOption(chosen.id);
    await page.getByLabel("Model reasoning effort").selectOption("high");
    await nav("Use live OpenAI");
    await expect(page.locator(".engine-settings")).toContainText(
      "Current mode: OpenAI",
    );
    expect(
      await page.evaluate(async () => {
        const r = await window.synora.backendStatus();
        return r.ok ? r.value.mode : r.error;
      }),
    ).toBe("inactive");
    await nav("Workspace");
    await expect(page.getByLabel("Reasoning profile")).toHaveCount(0);
    await expect(page.getByLabel("Context", { exact: true })).toHaveCount(0);
    await expect(
      page.getByText("Context: Core-managed", { exact: true }),
    ).toBeVisible();
    await page
      .getByLabel("Message", { exact: true })
      .fill("Read the owned provider-check.txt and confirm its marker.");
    await nav("Send message");
    await complete();
    const first = await snapshot();
    expect(
      await page.evaluate(async () => {
        const r = await window.synora.state();
        return r.ok ? r.value.conversations[0].binding?.cwd : null;
      }),
    ).toBe(workspace);
    const toolIds = first.items
      .filter((i) => i.type === "commandExecution" && i.status === "completed")
      .map((i) => i.id);
    expect(toolIds.length).toBeGreaterThan(0);
    expect(first.firstDeltaAt).toBeTruthy();
    expect(first.selection?.contextRequestField).toBe("core-managed");
    expect(first.backendRequests ?? []).toEqual([]);
    expect(state.toolResult.call_id).toBe("original-call-provider-read");
    expect(JSON.stringify(state.toolResult)).toContain(
      "SYNORA_PROVIDER_FILE_OK",
    );
    const initial = requests.filter((r) => r.body);
    expect(initial).toHaveLength(2);
    expect(
      initial.every(
        (r) => r.body.model === chosen.id && r.body.reasoning.effort === "high",
      ),
    ).toBe(true);
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_PROVIDER_OK",
    );
    expect(await readFile(join(workspace, "provider-check.txt"), "utf8")).toBe(
      "SYNORA_PROVIDER_FILE_OK\n",
    );
    const conversation = await page.evaluate(async () => {
      const r = await window.synora.state();
      if (!r.ok) throw Error(r.error.message);
      return r.value.conversations[0];
    });
    expect(conversation.binding?.sessionId).toBe(first.sessionId);
    await app!.close();
    app = undefined;
    page = await launch();
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_PROVIDER_OK",
    );
    await expect
      .poll(async () => (await snapshot()).threadId)
      .toBe(first.threadId);
    for (const id of toolIds)
      await expect(page.locator(`[data-item-id="${id}"]`)).toHaveCount(1);
    await page
      .getByLabel("Message", { exact: true })
      .fill("Confirm again after native process restart.");
    await nav("Send message");
    await complete();
    expect((await snapshot()).sessionId).toBe(first.sessionId);
    state.hold = true;
    await page
      .getByLabel("Message", { exact: true })
      .fill("Hold this controlled SSE stream for cancellation.");
    await nav("Send message");
    await expect.poll(() => state.heldRequests).toBe(1);
    const locked = await page.evaluate(() => window.synora.coreAccountLogout());
    expect(locked.ok).toBe(false);
    await nav("Cancel turn");
    await expect
      .poll(async () => {
        const s = await snapshot();
        return [s.status, s.cleanupPending ?? false];
      })
      .toEqual(["interrupted", false]);
    await expect.poll(() => state.cancelledStreams).toBe(1);
    state.hold = false;
    await page
      .getByLabel("Message", { exact: true })
      .fill("Resume after native cancellation.");
    await nav("Send message");
    await complete();
    expect((await snapshot()).sessionId).toBe(first.sessionId);
    const geometry = [];
    for (const [width, height, zoom] of [
      [1440, 960, 1],
      [900, 640, 1],
      [1000, 740, 1.5],
    ]) {
      await app!.evaluate(
        ({ BrowserWindow }, [w, h, z]) => {
          const win = BrowserWindow.getAllWindows()[0];
          win.setContentSize(w, h);
          win.webContents.setZoomFactor(z);
        },
        [width, height, zoom],
      );
      await expect
        .poll(() =>
          page!.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        )
        .toBe(true);
      const button = page.getByRole("button", {
        name: "Model settings",
        exact: true,
      });
      await button.scrollIntoViewIfNeeded();
      await button.click();
      await expect(page.getByLabel("Engine provider")).toHaveValue(providerId);
      await nav("Workspace");
      const dimensions = await app!.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return {
          content: win.getContentSize(),
          zoom: win.webContents.getZoomFactor(),
          png: (await win.capturePage()).toPNG().toString("base64"),
        };
      });
      geometry.push({
        requested: [width, height, zoom],
        content: dimensions.content,
        zoom: dimensions.zoom,
      });
      await writeFile(
        `test-results/openai-provider-native/workspace-${width}-${zoom}.png`,
        Buffer.from(dimensions.png, "base64"),
      );
    }
    await nav("Models & accounts");
    account = page.getByRole("article", { name: "OpenAI account" });
    await account
      .getByRole("button", { name: "Refresh OpenAI account" })
      .click();
    await expect(account).toContainText("API key saved");
    await account
      .getByRole("button", { name: "Sign out of Synora account" })
      .click();
    await expect(account).toContainText("Not signed in");
    await expect
      .poll(() =>
        page!.evaluate(async () => {
          const r = await window.synora.coreAccountStatus();
          return r.ok ? r.value.busy : r.error;
        }),
      )
      .toBe(false);
    const count = requests.length;
    const rejected = await page.evaluate(
      (id) => window.synora.engineStart(id, "No auth must not infer", "text"),
      conversation.id,
    );
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.message).toContain("Sign in");
    expect(requests.length).toBe(count);
    expect(
      await page.evaluate(
        async (secret) =>
          JSON.stringify(await window.synora.state()).includes(secret),
        key,
      ),
    ).toBe(false);
    await expect(
      readFile(join(fixture.accountHome, "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      `out/live-evidence/openai-provider-native-${process.platform === "win32" ? "windows" : "linux"}.json`,
      JSON.stringify(
        {
          passed: true,
          directory,
          coreSha256: await sha256File(fixture.core),
          scope:
            "Native Electron IPC + original Core + controlled Responses + real command; not public OpenAI auth/inference",
          executable:
            process.env.SYNORA_TEST_EXECUTABLE ?? "development Electron",
          catalog,
          sessionId: first.sessionId,
          threadId: first.threadId,
          turnId: first.turnId,
          toolIds,
          toolResult: state.toolResult,
          firstDeltaAt: first.firstDeltaAt,
          coldResume: true,
          cancelledStreams: state.cancelledStreams,
          logoutBlocksInference: true,
          geometry,
          errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      join(directory, "original-failure.json"),
      JSON.stringify(
        {
          error: String(error),
          stack: error instanceof Error ? error.stack : null,
          state:
            page && !page.isClosed()
              ? await page
                  .evaluate(() => window.synora.state())
                  .catch(() => null)
              : null,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await writeFile(
      join(directory, "native-diagnostics.json"),
      JSON.stringify({ errors, last, requests }, null, 2),
    );
    try {
      if (app && page && !page.isClosed()) {
        await page.evaluate(() => window.synora.engineCancel());
        await page.evaluate(() => window.synora.coreAccountLogout());
        if (process.platform === "win32") {
          const current = await page.evaluate(() => window.synora.state());
          if (!current.ok) throw Error(current.error.message);
          if (current.value.engine.mode !== "simulated") {
            await nav("Settings");
            await nav("Use simulator");
          }
          await expect
            .poll(async () => {
              const r = await page!.evaluate(() => window.synora.state());
              return r.ok ? r.value.engine.mode : r.error;
            })
            .toBe("simulated");
        }
      }
    } finally {
      await app?.close();
      await fixture.close();
    }
  }
});
