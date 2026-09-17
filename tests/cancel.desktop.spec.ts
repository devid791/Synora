import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, access, realpath } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { EngineSnapshot } from "../src/shared/contracts";
import { qualificationRuntime } from "./fixtures/qualification-runtime";

const run = promisify(execFile);
test("Packaged native Axiom cancels its real command, releases its process tree and resumes the same session", async () => {
  if (!["linux", "darwin"].includes(process.platform))
    throw Error("This POSIX command test does not qualify the Windows sandbox");
  const directory = await mkdtemp(join(await realpath(tmpdir()), "synora-cancel-native-"));
  const workspace = join(directory, "workspace"),
    state = join(directory, "state");
  await mkdir(workspace);
  await mkdir("out/live-evidence", { recursive: true });
  const scriptPath = join(workspace, "cancel-check.sh");
  const script =
    '#!/bin/sh\nset -eu\nprintf "%s\\n" "$$" > parent.pid\nsleep 20 &\nsleeper=$!\nprintf "%s\\n" "$sleeper" > sleeper.pid\nprintf "SYNORA_CANCEL_READY\\n"\nwait "$sleeper"\nprintf "SHOULD_NOT_FINISH\\n" > completed.txt\n';
  await writeFile(scriptPath, script, { flag: "wx", mode: 0o700 });
  let app: ElectronApplication | undefined, page: Page;
  let lastSnapshot: EngineSnapshot | undefined;
  const errors: string[] = [];
  const observedProcesses: {
    pid: number;
    namespacePid: number;
    appPid: number;
    command: string;
  }[] = [];
  const snapshot = async () => {
    lastSnapshot = await page.evaluate(async () => {
      const result = await window.synora.engineSnapshot();
      if (!result.ok) throw Error(result.error.message);
      return result.value;
    });
    if (lastSnapshot.status === "failed")
      throw Error(JSON.stringify(lastSnapshot.error));
    return lastSnapshot;
  };
  const launch = async () => {
    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: ["--disable-gpu"],
      chromiumSandbox: true,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_DATA_DIR: state },
    });
    page = await app.firstWindow();
    await qualificationRuntime(page);
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
  };
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const processState = async (pid: number) => {
    try {
      const r = await run("ps", ["-p", String(pid), "-o", "stat=,command="], {
        timeout: 3000,
      });
      return r.stdout.trim();
    } catch (e) {
      if ((e as { code?: number }).code === 1) return "";
      throw e;
    }
  };
  const identifyOwnedProcess = async (
    namespacePid: number,
    expectedCommand: string,
  ) => {
    const appPid = app!.process().pid!;
    // Only numeric parent relationships are read globally. Read command lines
    // and namespace IDs only after proving ancestry from this owned app.
    const rows = (
      await run("ps", ["-e", "-o", "pid=,ppid="], { timeout: 3000 })
    ).stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    const owned = new Set([appPid]);
    for (;;) {
      const size = owned.size;
      for (const [pid, parent] of rows) if (owned.has(parent)) owned.add(pid);
      if (size === owned.size) break;
    }
    const matches: typeof observedProcesses = [];
    for (const pid of owned) {
      if (pid === appPid) continue;
      let innerPid = pid;
      if (process.platform === "linux") {
        const status = await readFile(`/proc/${pid}/status`, "utf8").catch(
          (e) => {
            if (e.code === "ENOENT") return "";
            throw e;
          },
        );
        const ids = status
          .match(/^NSpid:\s+(.+)$/m)?.[1]
          .trim()
          .split(/\s+/);
        if (!ids?.length) continue;
        innerPid = Number(ids.at(-1));
      }
      if (innerPid !== namespacePid) continue;
      const command = await processState(pid);
      if (command.includes(expectedCommand))
        matches.push({ pid, namespacePid, appPid, command });
    }
    expect(
      matches,
      "namespace PID must resolve to one identified app-owned process",
    ).toHaveLength(1);
    return matches[0];
  };
  try {
    await launch();
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selected],
      })) as typeof dialog.showOpenDialog;
    }, workspace);
    await nav("Add workspace");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page!.getByLabel("Configuration ID").fill("cancel-axiom");
    await page!
      .getByLabel("Configuration name")
      .fill("Axiom cancellation qualification");
    await page!
      .getByLabel("Configuration endpoint")
      .fill(process.env.SYNORA_TEST_ENDPOINT!);
    await page!.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Settings");
    await page!.getByLabel("Engine provider").selectOption("cancel-axiom");
    await nav("Read live model catalog");
    await nav("Use live Axiom");
    // Click completion is not configuration completion: the service rejects
    // Send while its asynchronous provider validation is still in progress.
    const settings = page!.locator(".engine-settings");
    await expect(settings).toContainText("Current mode: Axiom");
    await expect(settings.locator("fieldset")).toBeEnabled();
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await nav("Workspace");
    await page!
      .getByLabel("Message", { exact: true })
      .fill(
        `Run exactly /bin/sh ${JSON.stringify(scriptPath)} in the current workspace using exec_command. This harmless local cancellation fixture sleeps twenty seconds. Do not change any files, spawn agents, use network or other tools. Wait for the command; the operator will interrupt it.`,
      );
    await nav("Send message");
    await expect
      .poll(
        async () => {
          const s = await snapshot();
          if (s.approval)
            throw Error("Unexpected approval in the sandboxed local fixture");
          return s.items.some(
            (i) => i.type === "commandExecution" && i.status === "inProgress",
          );
        },
        { timeout: 60000, intervals: [50, 100, 200] },
      )
      .toBe(true);
    for (const file of ["parent.pid", "sleeper.pid"]) {
      await expect
        .poll(
          async () => readFile(join(workspace, file), "utf8").catch(() => ""),
          { intervals: [20, 50] },
        )
        .toMatch(/^\d+\n$/);
      const namespacePid = Number(
        (await readFile(join(workspace, file), "utf8")).trim(),
      );
      expect(namespacePid).toBeGreaterThan(1);
      observedProcesses.push(
        await identifyOwnedProcess(
          namespacePid,
          file === "parent.pid" ? scriptPath : "sleep 20",
        ),
      );
    }
    const running = await snapshot();
    expect(running.status).toBe("running");
    const command = running.items.find(
      (i) => i.type === "commandExecution" && i.status === "inProgress",
    )!;
    const cancelledAt = Date.now();
    await nav("Cancel turn");
    await expect
      .poll(async () => (await snapshot()).status, { timeout: 15000 })
      .toBe("interrupted");
    await expect
      .poll(async () => Boolean((await snapshot()).cleanupPending), {
        timeout: 15000,
      })
      .toBe(false);
    const interrupted = await snapshot();
    expect(interrupted.turnId).toBe(running.turnId);
    expect(interrupted.threadId).toBe(running.threadId);
    expect(interrupted.sessionId).toBe(running.sessionId);
    for (const process of observedProcesses)
      await expect
        .poll(() => processState(process.pid), { timeout: 5000 })
        .toBe("");
    await expect
      .poll(async () => {
        const item = (await snapshot()).items.find((i) => i.id === command.id);
        return (
          item?.type === "commandExecution" &&
          ["completed", "failed", "declined"].includes(item.status)
        );
      })
      .toBe(true);
    await expect(
      access(join(workspace, "completed.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(scriptPath, "utf8")).toBe(script);
    await expect(page!.getByLabel("Reasoning profile")).toBeEnabled();
    await page!
      .getByLabel("Message", { exact: true })
      .fill(
        "The prior command was deliberately cancelled. Do not restart it or use any tools. Reply exactly SYNORA_CANCEL_RESUMED.",
      );
    await nav("Send message");
    await expect
      .poll(async () => (await snapshot()).status, { timeout: 90000 })
      .toBe("completed");
    const resumed = await snapshot();
    expect(resumed.sessionId).toBe(running.sessionId);
    expect(resumed.threadId).toBe(running.threadId);
    expect(resumed.turnId).not.toBe(running.turnId);
    expect(resumed.firstDeltaAt).toBeTruthy();
    await expect(page!.locator(".message.assistant")).toContainText(
      "SYNORA_CANCEL_RESUMED",
    );
    await app!.close();
    app = undefined;
    await launch();
    await expect
      .poll(async () => (await snapshot()).sessionId)
      .toBe(running.sessionId);
    await expect(page!.locator(`[data-item-id="${command.id}"]`)).toHaveCount(
      1,
    );
    await expect(page!.locator(".message.assistant")).toContainText(
      "SYNORA_CANCEL_RESUMED",
    );
    expect(errors).toEqual([]);
    await page!.screenshot({
      path: "test-results/cancel-native/recovered.png",
    });
    await writeFile(
      `out/live-evidence/cancel-native-${process.platform}.json`,
      JSON.stringify(
        {
          passed: true,
          directory,
          running,
          cancelledAt,
          interrupted,
          resumed,
          restored: await snapshot(),
          observedProcesses,
          errors,
          scope:
            "Packaged UI, original native Core, actual Axiom command cancellation and cold recovery; no production changes",
        },
        null,
        2,
      ),
    );
  } catch (e) {
    await writeFile(
      `out/live-evidence/cancel-native-${process.platform}-failure.json`,
      JSON.stringify(
        {
          directory,
          lastSnapshot,
          observedProcesses,
          errors,
          failure: String(e),
        },
        null,
        2,
      ),
    );
    throw e;
  } finally {
    await app?.close();
  }
});
