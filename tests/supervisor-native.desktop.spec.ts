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
import { tmpdir } from "node:os";
import type {
  DesktopAPI,
  Result,
  EngineSnapshot,
  AppState,
} from "../src/shared/contracts";

/** Actual packaged main/preload/IPC and original Core; no imported service,
 * patched engine, injected outcome or database seeding. One actual Axiom worker.
 * Windows requires its separate prepared-home qualification; never setup here. */
test("Packaged supervisor delegates one actual read, reviews the result and retains original identities through cold native restart", async () => {
  expect(["linux", "darwin"]).toContain(process.platform);
  const executable = process.env.SYNORA_TEST_EXECUTABLE!;
  expect(executable).toBeTruthy();
  const directory = await mkdtemp(
      join(await realpath(tmpdir()), "synora-supervisor-native-"),
    ),
    parent = join(directory, "supervisor"),
    child = join(directory, "worker"),
    marker = `NATIVE_WORKER_${randomUUID()}`;
  await Promise.all([
    mkdir(parent),
    mkdir(child),
    mkdir("out/live-evidence", { recursive: true }),
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
  ];
  let app: ElectronApplication | undefined, page!: Page;
  let final: EngineSnapshot | undefined,
    state: AppState | undefined,
    cold: AppState | undefined;
  let passed = false,
    failure: string | undefined;
  const errors: string[] = [];
  // A test-only client of the existing typed preload. It is never exposed as a
  // new renderer method or made available to browser/model content.
  const api = async <K extends keyof DesktopAPI>(
    name: K,
    args: Parameters<DesktopAPI[K]>,
  ): Promise<
    Awaited<ReturnType<DesktopAPI[K]>> extends Result<infer T> ? T : never
  > => {
    expect(allowed).toContain(name);
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
      env: { ...process.env, SYNORA_DATA_DIR: join(directory, "state") },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
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
    await api("integrationSave", [
      {
        id: "native-supervisor-axiom",
        name: "Native supervisor QA",
        kind: "provider",
        providerType: "axiom",
        endpoint: process.env.SYNORA_TEST_ENDPOINT!,
        enabled: true,
        auth: "none",
        tools: [],
      },
    ]);
    const models = await api("engineModels", ["native-supervisor-axiom"]);
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
      { mode: "live", providerId: "native-supervisor-axiom", model: model.id },
    ]);
    await api("preferences", [{ profile: "ultra-fast", context: 262144 }]);
    const root = await addWorkspace(parent),
      worker = await addWorkspace(child);
    const conversation = await api("newConversation", [root.id]);
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
              providerId: "native-supervisor-axiom",
              model: model.id,
              effort: "ultra-fast",
              context: 262144,
            },
          },
        ],
      },
    ]);
    const prompt =
      "Use synora_delegate exactly once with worker_id reader and task: Read read-only.txt in your working directory using one read-only file command and return its exact full contents. Do not write, access the network or spawn agents. Then use synora_wait for the delegated result. Do not use spawn_agent or read the file yourself. Verify the returned result, record an accepted synora_review with a summary referencing the actual result, then reply with only its exact marker. This is one bounded worker task, no replacement workers.";
    await api("saveDraft", [conversation.id, prompt]);
    await api("engineStart", [conversation.id, prompt, "text"]);
    await expect
      .poll(
        async () => {
          final = await api("engineSnapshot", []);
          if (final.status === "failed") throw Error(String(final.error));
          expect(final.approval).toBeFalsy();
          return final.status;
        },
        { timeout: 180000 },
      )
      .toBe("completed");
    state = await api("state", []);
    expect(state.delegations).toHaveLength(1);
    const task = state.delegations[0];
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
    expect(cold.delegations).toEqual(state.delegations);
    expect(
      cold.conversations.find((c) => c.id === conversation.id)?.binding,
    ).toEqual(
      state.conversations.find((c) => c.id === conversation.id)?.binding,
    );
    await page.getByRole("button", { name: "Agents", exact: true }).click();
    // Model supplies the task's name; the configured worker name is independent.
    const actualCard = page.getByRole("article", {
      name: `Delegated task ${task.name}`,
      exact: true,
    });
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
      `out/live-evidence/supervisor-native-${process.platform}.png`,
      Buffer.from(pixels, "base64"),
    );
    expect(errors).toEqual([]);
    passed = true;
  } catch (e) {
    failure = String(e);
    throw e;
  } finally {
    try {
      await app?.close();
    } finally {
      await writeFile(
        `out/live-evidence/supervisor-native-${process.platform}.json`,
        JSON.stringify(
          {
            passed,
            failure,
            directory,
            executable,
            final,
            state,
            cold,
            errors,
            scope:
              "Actual packaged IPC, original Core and Axiom one-worker read/review/cold state; no public provider grant or performance claim",
          },
          null,
          2,
        ),
      );
    }
  }
});
