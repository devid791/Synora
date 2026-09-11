import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  frozen,
  executable,
  dataRoot,
  core,
  requireWindowsAdmission,
  protectedIdentity,
  inspectSession,
  readPreparedState,
  assertPreserved,
  assertInitialRecovery,
  newDelegations,
} from "./fixtures/supervisor-windows-admission";
import type {
  DesktopAPI,
  Result,
  EngineSnapshot,
  AppState,
} from "../src/shared/contracts";

/** Windows QA-only prepared-home adaptation. No runtime patch, fresh Core home,
 * setup, elevation, account import or seeded result. Explicit GPU handoff first. */
test("Windows package: one new reader delegation, accepted original review and cold identity in the existing prepared home", async ({}, testInfo) => {
  requireWindowsAdmission();
  const sessionBefore = await inspectSession();
  const identityBefore = await protectedIdentity();
  const before = readPreparedState();
  expect(before.conversations.length).toBeGreaterThan(0);
  expect(
    before.delegations.some((t) => ["queued", "running"].includes(t.status)),
  ).toBe(false);
  const evidence = testInfo.config.metadata.evidence_directory as string;
  expect(evidence).toBeTruthy();
  const providerId = `windows-supervisor-${randomUUID()}`;
  const directory = await mkdtemp(
      join(await realpath(frozen.prepared), "supervisor-windows-"),
    ),
    parent = join(directory, "supervisor"),
    child = join(directory, "worker"),
    marker = `NATIVE_WORKER_${randomUUID()}`;
  await Promise.all([
    mkdir(parent),
    mkdir(child),
    mkdir(evidence, { recursive: true }),
  ]);
  await writeFile(join(child, "read-only.txt"), marker + "\n", { flag: "wx" });
  const allowed: (keyof DesktopAPI)[] = [
    "integrationSave",
    "engineModels",
    "engineConfigure",
    "preferences",
    "chooseWorkspace",
    "newConversation",
    "orchestrationConfigure",
    "saveDraft",
    "engineStart",
    "engineSnapshot",
    "state",
    "engineRestore",
    "engineNativeSetup",
    "coreUpdateStatus",
  ];
  let app: ElectronApplication | undefined, page!: Page;
  let final: EngineSnapshot | undefined,
    state: AppState | undefined,
    cold: AppState | undefined;
  let passed = false,
    failure: string | undefined;
  const errors: string[] = [],
    cleanupErrors: string[] = [];
  const appPids: number[] = [],
    launcherPids: number[] = [],
    identities: unknown[] = [];
  const processObservations: Awaited<ReturnType<typeof inspectSession>>[] = [];
  let readiness: unknown, identityAfter: unknown, sessionAfter: unknown;
  let conversationId: string | undefined;
  let startedTurns = 0;
  let initialRecovery: EngineSnapshot | undefined;
  let recoveredState: AppState | undefined;
  let recoveryDifferences: ReturnType<typeof assertInitialRecovery> = [];
  let historyBaseline = before;
  let appPid: number | undefined;
  let afterCloseState: AppState | undefined;
  // A test-only client of the existing typed preload. It is never exposed as a
  // new renderer method or made available to browser/model content.
  const api = async <K extends keyof DesktopAPI>(
    name: K,
    args: Parameters<DesktopAPI[K]>,
  ): Promise<
    Awaited<ReturnType<DesktopAPI[K]>> extends Result<infer T> ? T : never
  > => {
    expect(allowed).toContain(name);
    if (name === "engineNativeSetup")
      expect(args.length, "Readiness only; never setup mode").toBe(2);
    if (name === "engineStart") {
      expect(args[0]).toBe(conversationId);
      expect(++startedTurns, "No automatic inference retry").toBe(1);
    }
    const r = await page.evaluate(
      async ({ name, args }) =>
        (window.synora[name] as (...a: any[]) => Promise<Result<unknown>>)(
          ...args,
        ),
      { name, args },
    );
    if (!r.ok) throw Error(`${r.error.code}: ${r.error.message}`);
    return r.value as any;
  };
  const launch = async () => {
    app = await _electron.launch({
      executablePath: executable,
      args: ["--disable-gpu"],
      chromiumSandbox: true,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_DATA_DIR: dataRoot },
    });
    // Playwright uses shell:true on Windows: process().pid is cmd.exe, not
    // the packaged Electron main. Bind both identities before any model turn.
    const launcherPid = app.process().pid!;
    const mainProcess = await app.evaluate(() => ({
      pid: process.pid,
      ppid: process.ppid,
    }));
    expect(mainProcess.ppid).toBe(launcherPid);
    appPid = mainProcess.pid;
    launcherPids.push(launcherPid);
    appPids.push(appPid);
    processObservations.push(await inspectSession(appPid));
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    identities.push(
      await app.evaluate(
        ({ app, BrowserWindow }, expected) => {
          const load = process
            .getBuiltinModule("module")
            .createRequire(app.getAppPath() + "/package.json");
          const path = load("node:path");
          const prefs = (
            BrowserWindow.getAllWindows()[0].webContents as any
          ).getLastWebPreferences();
          const preload = (
            BrowserWindow.getAllWindows()[0].webContents as any
          )._getPreloadScript();
          if (
            !app.isPackaged ||
            process.execPath.toLowerCase() !==
              expected.executable.toLowerCase() ||
            app.getPath("userData").toLowerCase() !==
              expected.dataRoot.toLowerCase() ||
            !load.cache[path.join(app.getAppPath(), "dist/main.cjs")]?.loaded ||
            !prefs.sandbox ||
            !prefs.contextIsolation ||
            prefs.nodeIntegration ||
            process.argv.includes("--no-sandbox")
          )
            throw Error("Packaged main/data/sandbox identity mismatch");
          if (
            preload.filePath !== path.join(app.getAppPath(), "dist/preload.cjs")
          )
            throw Error("Original packaged preload required");
          return {
            packaged: app.isPackaged,
            executable: process.execPath,
            appPath: app.getAppPath(),
            dataRoot: app.getPath("userData"),
            preload,
            sandbox: prefs.sandbox,
            contextIsolation: prefs.contextIsolation,
            nodeIntegration: prefs.nodeIntegration,
            node: process.versions.node,
            electron: process.versions.electron,
          };
        },
        { executable, dataRoot },
      ),
    );
    expect((await api("coreUpdateStatus", [])).currentVersion).toBe("0.153.4");
    await protectedIdentity();
  };
  const addWorkspace = async (path: string) => {
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selected],
      })) as typeof dialog.showOpenDialog;
    }, path);
    const workspace = await api("chooseWorkspace", []);
    expect(workspace?.path).toBe(path);
    return workspace!;
  };
  try {
    await launch();
    const prior = before.conversations[0];
    if (before.engine.mode === "live" && prior.binding) {
      // Original renderer automatically calls engineRestore; await it without
      // another restore/start request. Core resumes/lists recorded history only.
      await expect
        .poll(
          async () => {
            initialRecovery = await api("engineSnapshot", []);
            if (initialRecovery.status === "failed" || initialRecovery.error)
              throw Error(
                `Initial historical recovery: ${JSON.stringify(initialRecovery.error)}`,
              );
            expect(initialRecovery.approval).toBeNull();
            return (
              initialRecovery.conversationId === prior.id &&
              initialRecovery.connection === "live" &&
              // A retained prior QA cancellation is a valid terminal history
              // state, not permission to restart it or a completed P13 result.
              ["idle", "completed", "interrupted"].includes(
                initialRecovery.status,
              )
            );
          },
          { timeout: 75000 },
        )
        .toBe(true);
      expect(initialRecovery!.threadId).toBe(prior.binding.threadId);
      expect(initialRecovery!.sessionId).toBe(prior.binding.sessionId);
      expect(initialRecovery!.turnId).toBeTruthy();
      for (const item of initialRecovery!.items)
        expect(
          prior.itemOrder,
          "Recovery must not invent a new historical item",
        ).toContain(item.id);
      expect(startedTurns).toBe(0);
      recoveredState = await api("state", []);
      recoveryDifferences = assertInitialRecovery(before, recoveredState);
      historyBaseline = recoveredState;
      await protectedIdentity();
    }
    await api("integrationSave", [
      {
        id: providerId,
        name: "Native supervisor QA",
        kind: "provider",
        providerType: "axiom",
        endpoint: process.env.SYNORA_TEST_ENDPOINT!,
        enabled: true,
        auth: "none",
        tools: [],
      },
    ]);
    const root = await addWorkspace(parent),
      worker = await addWorkspace(child);
    const conversation = await api("newConversation", [root.id]);
    conversationId = conversation.id;
    // A fresh renderer selects the newly-prepended conversation rather than
    // restoring the previous provider/workspace when we change engine settings.
    await page.reload();
    await page.getByRole("button", { name: "Workspace", exact: true }).click();
    await expect(page.getByLabel("Active workspace")).toHaveValue(root.id);
    expect((await api("state", [])).conversations[0].id).toBe(conversation.id);
    readiness = await api("engineNativeSetup", [providerId, root.id]);
    expect(readiness).toEqual({ platform: "win32", status: "ready" });
    await protectedIdentity();
    const models = await api("engineModels", [providerId]);
    const requested = process.env.SYNORA_TEST_MODEL;
    const available = models.filter(
      (m) => !m.unavailableReason && (!requested || m.id === requested),
    );
    expect(
      available,
      "Require one exact available model or explicit SYNORA_TEST_MODEL",
    ).toHaveLength(1);
    const model = available[0];
    expect(model.reasoning_efforts).toContain("ultra-fast");
    expect(model.context_window_options).toContain(262144);
    await api("engineConfigure", [
      { mode: "live", providerId: providerId, model: model.id },
    ]);
    await api("preferences", [{ profile: "ultra-fast", context: 262144 }]);

    await api("orchestrationConfigure", [
      conversation.id,
      {
        externalSharingConfirmed: true,
        workers: [
          {
            id: "reader",
            name: "Native read-only worker",
            workspaceId: worker.id,
            timeoutMs: 120000,
            selection: {
              providerId: providerId,
              model: model.id,
              effort: "ultra-fast",
              context: 262144,
            },
          },
        ],
      },
    ]);
    const prompt =
      "Use synora_delegate exactly once with worker_id reader and task: Read read-only.txt in your working directory using exactly one read-only PowerShell command, Get-Content -LiteralPath 'read-only.txt' -Raw, and return its exact full contents. Do not write, access the network or spawn agents. Then use synora_wait for the delegated result. Do not use spawn_agent or read the file yourself. Verify the returned result, record an accepted synora_review with a summary referencing the actual result, then reply with only its exact marker. This is one bounded worker task, no replacement workers.";
    await api("saveDraft", [conversation.id, prompt]);
    await api("engineStart", [conversation.id, prompt, "text"]);
    await expect
      .poll(
        async () => {
          final = await api("engineSnapshot", []);
          processObservations.push(await inspectSession(appPid!));
          if (final.status === "failed") throw Error(String(final.error));
          expect(final.approval).toBeFalsy();
          return final.status;
        },
        { timeout: 180000 },
      )
      .toBe("completed");
    state = await api("state", []);
    assertPreserved(historyBaseline, state);
    const created = newDelegations(before, state, conversation.id);
    expect(created).toHaveLength(1);
    const task = created[0];
    expect(final!.conversationId).toBe(conversation.id);
    expect(final!.selection).toEqual({
      model: model.id,
      profile: "ultra-fast",
      context: 262144,
      contextRequestField: "context_window",
    });
    const savedWorker = state.conversations.find(
      (c) => c.id === conversation.id,
    )!.orchestration!.workers[0];
    expect(savedWorker.selection).toEqual({
      providerId,
      model: model.id,
      effort: "ultra-fast",
      context: 262144,
    });
    expect(savedWorker.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(savedWorker.workspaceId).toBe(worker.id);
    expect(task.parentTurnId).toBe(final!.turnId);
    const commands = task.items!.filter(
      (i: any) => i.type === "commandExecution",
    ) as any[];
    expect(commands).toHaveLength(1);
    expect(commands[0].cwd.toLowerCase()).toBe(child.toLowerCase());
    for (const items of [task.items!, final!.items])
      expect(items.some((i: any) => /^collabAgent/.test(i.type))).toBe(false);
    const workerMetrics = (task.tokenUsage as any)?.axiom;
    for (const metrics of [final!.backendRequests, workerMetrics]) {
      expect(metrics?.length).toBeGreaterThan(0);
      for (const entry of metrics!) {
        expect(entry.model).toBe(model.id);
        expect(entry.profile).toBe("ultra-fast");
      }
    }
    expect(
      processObservations.some((r) =>
        r.children.some(
          (p) => p.ExecutablePath?.toLowerCase() === core.toLowerCase(),
        ),
      ),
    ).toBe(true);
    expect(task.status, task.error).toBe("completed");
    expect(task.result).toContain(marker);
    expect(task.review?.verdict).toBe("accepted");
    expect(task.review?.parentThreadId).toBe(final!.threadId);
    expect(task.review?.parentTurnId).toBe(final!.turnId);
    expect(task.review?.callId).toBeTruthy();
    expect(task.review!.callId).not.toBe(task.callId);
    expect(task.parentThreadId).toBe(final!.threadId);
    for (const id of [
      task.id,
      task.callId,
      task.threadId,
      task.turnId,
      task.sessionId,
    ])
      expect(id).toBeTruthy();
    expect(task.threadId).not.toBe(final!.threadId);
    expect(task.sessionId).not.toBe(final!.sessionId);
    expect(
      task.items?.some(
        (item: any) =>
          item.type === "commandExecution" &&
          item.exitCode === 0 &&
          item.aggregatedOutput.includes(marker),
      ),
    ).toBe(true);
    expect(
      final!.items
        .filter((i) => i.type === "agentMessage")
        .map((i) => i.text)
        .join("\n"),
    ).toContain(marker);
    expect(final!.error).toBeNull();
    expect(await readFile(join(child, "read-only.txt"), "utf8")).toBe(
      marker + "\n",
    );
    await app!.close();
    app = undefined;
    await launch();
    await expect
      .poll(async () => (await api("engineSnapshot", [])).connection)
      .toBe("live");
    const restored = await api("engineSnapshot", []);
    expect(restored.threadId).toBe(final!.threadId);
    expect(restored.sessionId).toBe(final!.sessionId);
    expect(restored.error).toBeNull();
    cold = await api("state", []);
    assertPreserved(historyBaseline, cold);
    expect(newDelegations(before, cold, conversation.id)).toEqual(created);
    expect(
      cold.conversations.find((c) => c.id === conversation.id)?.binding,
    ).toEqual(
      state.conversations.find((c) => c.id === conversation.id)?.binding,
    );
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    // Model supplies the task's name; the configured worker name is independent.
    const actualCard = page
      .getByRole("article", {
        name: `Delegated task ${task.name}`,
        exact: true,
      })
      .filter({
        has: page.getByText(task.id, { exact: true }),
      });
    await expect(actualCard).toHaveCount(1);
    await expect(actualCard).toBeVisible();
    await expect(
      actualCard
        .getByRole("region", { name: "Supervisor review", exact: true })
        .getByText("Accepted", { exact: true }),
    ).toBeVisible();
    await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5),
    );
    await actualCard.scrollIntoViewIfNeeded();
    await page.evaluate(
      () =>
        new Promise<void>((r) =>
          requestAnimationFrame(() => requestAnimationFrame(() => r())),
        ),
    );
    await page.waitForTimeout(150);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const pixels = await app!.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(
      join(evidence, "supervisor-windows-150.png"),
      Buffer.from(pixels, "base64"),
    );
    expect(errors).toEqual([]);
    passed = true;
  } catch (e) {
    failure = String(e);
    try {
      if (app && page) {
        state ??= await api("state", []);
        const pixels = await app.evaluate(async ({ BrowserWindow }) =>
          (await BrowserWindow.getAllWindows()[0].capturePage())
            .toPNG()
            .toString("base64"),
        );
        await writeFile(
          join(evidence, "failure-original.png"),
          Buffer.from(pixels, "base64"),
        );
      }
    } catch (captureError) {
      cleanupErrors.push(`Failure capture: ${String(captureError)}`);
    }
    throw e;
  } finally {
    try {
      await app?.close();
    } catch (e) {
      cleanupErrors.push(`Owned app close: ${String(e)}`);
    }
    try {
      identityAfter = await protectedIdentity();
      expect(identityAfter).toEqual(identityBefore);
      sessionAfter = await inspectSession();
      afterCloseState = readPreparedState();
      assertPreserved(historyBaseline, afterCloseState);
    } catch (e) {
      cleanupErrors.push(`Final identity/ownership/history: ${String(e)}`);
    }
    {
      await writeFile(
        join(evidence, "evidence.json"),
        JSON.stringify(
          {
            passed: passed && cleanupErrors.length === 0,
            failure,
            metadata: testInfo.config.metadata,
            before,
            initialRecovery,
            recoveredState,
            recoveryDifferences,
            providerId,
            conversationId,
            sessionBefore,
            sessionAfter,
            identityBefore,
            identityAfter,
            readiness,
            processObservations,
            identities,
            appPids,
            launcherPids,
            afterCloseState,
            startedTurns,
            cleanupErrors,
            directory,
            executable,
            final,
            state,
            cold,
            errors,
            scope:
              "Windows actual package/original prepared Core: one NEW reader and accepted review/cold IDs; NOT EXECUTED by preparation/typecheck, no public provider or performance claim",
          },
          null,
          2,
        ),
      );
    }
    if (!failure) expect(cleanupErrors).toEqual([]);
  }
});
