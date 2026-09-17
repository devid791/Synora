import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { EngineSnapshot } from "../src/shared/contracts";
import { qualificationRuntime } from "./fixtures/qualification-runtime";
test("Native desktop actual Axiom tool turn, incremental UI, app restart and original session recovery", async () => {
  if (
    process.platform === "win32" &&
    process.env.SYNORA_AUTHORIZE_WINDOWS_SETUP === "1"
  )
    test.setTimeout(780000);
  await mkdir("out/live-evidence", { recursive: true });
  const prepared = process.env.SYNORA_TEST_PREPARED_WINDOWS_QA;
  if (prepared) {
    expect(process.platform).toBe("win32");
    expect(resolve(prepared)).toMatch(
      /^C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-[A-Za-z0-9]+$/,
    );
  }
  const dir = prepared
      ? resolve(prepared)
      : await mkdtemp(join(await realpath(tmpdir()), "synora-live-native-")),
    workspace = join(dir, "workspace");
  if (prepared) {
    if (process.env.SYNORA_CORE_QUALIFICATION_WORKTREE === "1") {
      // Repeatable setup of this exact dedicated fixture, not user files.
      // A previous test's AFTER sentinel must not make the next run fail before
      // any model request. Unexpected contents still require investigation.
      const sentinel = await readFile(join(workspace, "native-check.txt"), "utf8");
      expect(["SYNORA_NATIVE_BEFORE\n", "SYNORA_NATIVE_AFTER\n"]).toContain(sentinel);
      if (sentinel === "SYNORA_NATIVE_AFTER\n")
        await writeFile(join(workspace, "native-check.txt"), "SYNORA_NATIVE_BEFORE\n");
    }
    if (process.env.SYNORA_QA_RESET_AFTER_SUCCESS === "1") {
      // Reinitialize only our exact fixture after a recorded successful run.
      // Its old report must be archived by the caller; histories are retained.
      const previous = JSON.parse(
        await readFile(
          process.env.SYNORA_QA_PREVIOUS_LIVE_RECEIPT ??
            "out/live-evidence/live-native.json",
          "utf8",
        ),
      );
      expect(resolve(previous.dir)).toBe(dir);
      expect(previous.original.status).toBe("completed");
      expect(previous.restored.status).toBe("completed");
      expect(await readFile(join(workspace, "native-check.txt"), "utf8")).toBe(
        "SYNORA_NATIVE_AFTER\n",
      );
      await writeFile(
        join(workspace, "native-check.txt"),
        "SYNORA_NATIVE_BEFORE\n",
      );
    }
    // Reuse the original private Core state; never copy sandbox credentials.
    expect(await readFile(join(workspace, "native-check.txt"), "utf8")).toBe(
      "SYNORA_NATIVE_BEFORE\n",
    );
  } else {
    await mkdir(workspace);
    await writeFile(
      join(workspace, "native-check.txt"),
      "SYNORA_NATIVE_BEFORE\n",
    );
  }
  let app: ElectronApplication | undefined;
  let lastSnapshot: EngineSnapshot | undefined;
  const approvals: NonNullable<EngineSnapshot["approval"]>[] = [];
  let nativeSetup: unknown;
  const errors: string[] = [];
  const launch = async () => {
    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: process.env.SYNORA_TEST_EXECUTABLE
        ? ["--disable-gpu"]
        : [".", "--disable-gpu"],
      chromiumSandbox: true,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_DATA_DIR: join(dir, "state") },
    });
    const page = await app.firstWindow();
    await qualificationRuntime(page);
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    return page;
  };
  const nav = (p: Page, name: string) =>
    p.getByRole("button", { name, exact: true }).click();
  const snapshot = async (p: Page) => {
    lastSnapshot = await p.evaluate(async () => {
      const r = await window.synora.engineSnapshot();
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    });
    return lastSnapshot;
  };
  try {
    let page = await launch();
    const readCommand = `Get-Content -LiteralPath "${join(workspace, "native-check.txt")}" -Raw`;
    if (prepared) {
      // Preserve the failed attempt's history; retry in a new conversation
      // while keeping the same already-provisioned private Core state.
      await nav(page, "New conversation");
      const initial = await snapshot(page);
      expect(initial.threadId).toBeFalsy();
      expect(initial.turnId).toBeFalsy();
      await nav(page, "Workspace");
      const workspaceId = await page.evaluate(async (path) => {
        const r = await window.synora.state();
        if (!r.ok) throw Error(r.error.message);
        return r.value.workspaces.find((w) => w.path === path)?.id;
      }, workspace);
      expect(
        workspaceId,
        "select our fixture, not the last provider workspace",
      ).toBeTruthy();
      await page.getByLabel("Active workspace").selectOption(workspaceId!);
      // The dedicated prepared Windows fixture may outlive the lab's endpoint
      // address. Migrate only its named provider through the normal editor,
      // after opening a fresh conversation; never copy its private Core home.
      const provider = await page.evaluate(async () => {
        const r = await window.synora.state();
        if (!r.ok) throw Error(r.error.message);
        return r.value.integrations.find(i => i.id === "native-axiom");
      });
      expect(provider?.kind).toBe("provider");
      if (provider!.endpoint !== process.env.SYNORA_TEST_ENDPOINT) {
        // Only the already-asserted native-axiom provider in the exact owned QA
        // home may migrate. A dedicated runner may use its loopback tunnel.
        expect(["http:", "https:"]).toContain(new URL(process.env.SYNORA_TEST_ENDPOINT!).protocol);
        expect(new URL(process.env.SYNORA_TEST_ENDPOINT!).pathname).toBe("/codex/v1");
        await nav(page, "Models & accounts");
        await expect(page.getByRole("article", { name: "OpenAI account", exact: true }))
          .toContainText("Account checked", { timeout: 20000 });
        await nav(page, "Settings");
        const disconnect = page.getByRole("button", { name: "Use simulator", exact: true });
        if (await disconnect.isEnabled()) await disconnect.click();
        await expect.poll(() => page.evaluate(async () => {
          const r = await window.synora.state();
          return r.ok ? r.value.engine.mode : null;
        })).toBe("simulated");
        // Editing the selected live provider is deliberately rejected by Core's
        // service guard. Disconnect it first; no simulated turn is ever sent.
        await nav(page, "Models & accounts");
        await page.locator("article.card").filter({ has: page.getByText(provider!.name, { exact: true }) })
          .getByRole("button", { name: "Edit", exact: true }).click();
        await page.getByLabel("Configuration endpoint").fill(process.env.SYNORA_TEST_ENDPOINT!);
        await nav(page, "Save configuration");
        await expect(page.getByRole("dialog")).toHaveCount(0);
      }
    } else {
      await app!.evaluate(({ dialog }, selected) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [selected],
        })) as typeof dialog.showOpenDialog;
      }, workspace);
      await nav(page, "Add workspace");
      await nav(page, "Models & accounts");
      await expect(page.getByRole("article", { name: "OpenAI account", exact: true }))
        .toContainText("Account checked", { timeout: 20000 });
      await nav(page, "Add configuration");
      await page.getByLabel("Configuration ID").fill("native-axiom");
      await page.getByLabel("Configuration name").fill("Native qualification");
      await page
        .getByLabel("Configuration endpoint")
        .fill(process.env.SYNORA_TEST_ENDPOINT!);
      await page.getByLabel("Enable configuration").check();
      await nav(page, "Save configuration");
    }
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.synora.state();
          if (!r.ok) throw Error(r.error.message);
          const c = r.value.conversations[0];
          return r.value.workspaces.find((w) => w.id === c.workspaceId)?.path;
        }),
      )
      .toBe(workspace);
    await nav(page, "Settings");
    await page.getByLabel("Engine provider").selectOption("native-axiom");
    await nav(page, "Read live model catalog");
    await expect(page.getByLabel("Engine model")).toBeEnabled();
    if (
      process.platform === "win32" &&
      (process.env.SYNORA_AUTHORIZE_WINDOWS_SETUP === "1" || prepared)
    ) {
      // Explicit user-authorized OS preparation, never an automatic test or
      // weaker sandbox fallback. Exercise the same installed-app UI operation.
      await page
        .getByText("Native tool prerequisites", { exact: true })
        .click();
      await nav(page, "Check native tool setup");
      await expect(
        page.getByRole("button", { name: "Check native tool setup" }),
      ).toBeEnabled({ timeout: 30000 });
      if (!prepared) await nav(page, "Set up administrator sandbox");
      await expect
        .poll(
          async () => {
            const error = page.locator(".engine-settings .error");
            if (await error.isVisible()) throw Error(await error.innerText());
            return page.locator(".native-tool-setup").innerText();
          },
          { timeout: prepared ? 30000 : 610000 },
        )
        .toContain("Native setup: ready");
      nativeSetup = {
        mode: "elevated",
        status: await page.locator(".native-tool-setup").innerText(),
        at: new Date().toISOString(),
      };
    }
    await nav(page, "Use live Axiom");
    await expect(page.locator(".engine-settings")).toContainText(
      "Current mode: Axiom",
    );
    await nav(page, "Workspace");
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "Read native-check.txt using tools. Use apply_patch to replace its contents with SYNORA_NATIVE_AFTER followed by a single LF newline and verify it by reading it again. Do not modify other files. Then reply exactly SYNORA_NATIVE_OK." +
          (process.platform === "win32"
            ? ` For both reads use exec_command with exactly this PowerShell cmd: ${readCommand}`
            : ""),
      );
    await nav(page, "Send message");
    await expect
      .poll(
        async () => {
          const state = await snapshot(page);
          if (state.approval) {
            // Windows Core can require operator consent even for a workspace
            // read before native sandbox setup. Exercise the actual UI without
            // disabling it or granting a session/prefix/general command rule.
            const request = state.approval;
            if (approvals.some((a) => a.id === request.id)) return state.status;
            expect(process.platform).toBe("win32");
            expect(approvals.length).toBeLessThan(2);
            expect(request.params.threadId).toBe(state.threadId);
            expect(request.params.turnId).toBe(state.turnId);
            const params = request.params;
            if (!("command" in params))
              throw new Error(
                `Unexpected qualification approval: ${JSON.stringify(request)}`,
              );
            const shell = join(
              process.env.SystemRoot ?? "C:\\Windows",
              "System32",
              "WindowsPowerShell",
              "v1.0",
              "powershell.exe",
            );
            // Compare the complete rendered command, not best-effort actions or
            // substring matching. Only this fixture's read may be approved.
            expect(params.command).toBe(
              `${JSON.stringify(shell)} -Command ${JSON.stringify(readCommand)}`,
            );
            expect(resolve(params.cwd!)).toBe(resolve(workspace));
            expect(params.networkApprovalContext).toBeFalsy();
            await expect(page.locator(".approval")).toBeVisible();
            await expect(page.locator(".approval code")).toHaveText(
              params.command!,
            );
            approvals.push(request);
            await nav(page, "Approve once");
          }
          if (state.status === "failed")
            throw new Error(JSON.stringify(state.error));
          return state.status;
        },
        { timeout: 120000 },
      )
      .toBe("completed");
    const original = await snapshot(page);
    for (const item of original.items)
      if (item.type === "commandExecution")
        expect(resolve(item.cwd)).toBe(workspace);
    expect(original.backendRequests?.length).toBeGreaterThan(0);
    for (const request of original.backendRequests!) {
      expect(request.threadId).toBe(original.threadId);
      expect(request.turnId).toBe(original.turnId);
      expect(request.sessionId).toBe(original.sessionId);
      expect(request.profile).toBe("ultra-fast");
      expect(request.thinkingTokens + request.visibleTokens).toBe(
        request.outputTokens,
      );
    }
    expect(original.firstDeltaAt).toBeTruthy();
    expect(original.tokenUsage?.last.outputTokens).toBeGreaterThan(0);
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_NATIVE_OK",
    );
    expect(await readFile(join(workspace, "native-check.txt"), "utf8")).toBe(
      "SYNORA_NATIVE_AFTER\n",
    );
    const toolIds = original.items
      .filter((i) => i.type === "commandExecution" || i.type === "fileChange")
      .map((i) => i.id);
    expect(toolIds.length).toBeGreaterThan(0);
    // Close only this test instance. Existing installed applications stay untouched.
    await app!.close();
    app = undefined;
    page = await launch();
    await expect(page.locator(".message.assistant")).toContainText(
      "SYNORA_NATIVE_OK",
    );
    await expect
      .poll(async () => (await snapshot(page)).threadId)
      .toBe(original.threadId);
    await expect
      .poll(async () => (await snapshot(page)).status)
      .toBe("completed");
    expect((await snapshot(page)).sessionId).toBe(original.sessionId);
    expect((await snapshot(page)).backendRequests).toEqual(
      original.backendRequests,
    );
    for (const id of toolIds)
      await expect(page.locator(`[data-item-id="${id}"]`)).toHaveCount(1);
    await nav(page, "Telemetry & backend");
    await expect(
      page
        .locator(".card")
        .filter({ has: page.getByRole("heading", { name: "Engine identity" }) })
        .locator("dl"),
    ).toContainText(original.sessionId!);
    await expect(page.locator(".axiom-telemetry")).toContainText(
      "Thinking tokens",
    );
    await expect(page.locator(".axiom-telemetry summary")).toHaveCount(
      original.backendRequests!.length,
    );
    await page.locator(".axiom-telemetry summary").first().click();
    await expect(
      page.locator(".axiom-telemetry details").first(),
    ).toContainText(original.turnId!);
    const png = await app!.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(
      "test-results/live-desktop/actual-telemetry.png",
      Buffer.from(png, "base64"),
    );
    expect(errors).toEqual([]);
    await writeFile(
      "out/live-evidence/live-native.json",
      JSON.stringify(
        {
          dir,
          original,
          restored: await snapshot(page),
          toolIds,
          approvals,
          nativeSetup,
          errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await writeFile(
      "out/live-evidence/live-native-failure.json",
      JSON.stringify(
        {
          dir,
          lastSnapshot,
          approvals,
          nativeSetup,
          errors,
          failure: String(error),
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
