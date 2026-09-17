import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { EngineSnapshot } from "../src/shared/contracts";
import { conversationTimeline } from "../src/renderer/conversation-timeline";
import { qualificationRuntime } from "./fixtures/qualification-runtime";

async function assertResumedAssistant(
  page: Page,
  snapshot: EngineSnapshot,
  identity: Pick<
    EngineSnapshot,
    "conversationId" | "sessionId" | "threadId" | "turnId"
  > & {
    messageId: string;
  },
) {
  const { messageId, ...binding } = identity;
  for (const value of Object.values(identity)) expect(value).toBeTruthy();
  expect(snapshot).toMatchObject({
    ...binding,
    connection: "live",
    status: "completed",
    error: null,
  });
  const matches = snapshot.items.filter((entry) => entry.id === messageId);
  expect(matches).toHaveLength(1);
  expect(matches[0]).toMatchObject({
    type: "agentMessage",
    text: "SYNORA_CANCEL_RESUMED",
  });
  const state = await page.evaluate(async () => {
    const result = await window.synora.state();
    if (!result.ok) throw Error(result.error.message);
    return result.value;
  });
  const conversation = state.conversations.find(
    (entry) => entry.id === identity.conversationId,
  );
  expect(conversation?.binding).toMatchObject({
    threadId: identity.threadId,
    sessionId: identity.sessionId,
  });
  // Message articles have no DOM ID. Resolve the exact engine-item identity
  // through the renderer's real timeline order, not history text or .last().
  const assistants = conversationTimeline(conversation, snapshot).filter(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  const index = assistants.findIndex((entry) => entry.id === messageId);
  expect(index).toBeGreaterThanOrEqual(0);
  const rendered = page.locator(".message.assistant");
  await expect(rendered).toHaveCount(assistants.length);
  await expect(rendered.nth(index).locator(".message-text")).toHaveText(
    "SYNORA_CANCEL_RESUMED",
  );
}

test("Windows native package cancels its sandboxed PowerShell tree and restores the original session", async () => {
  expect(process.platform).toBe("win32");
  const directory = resolve(process.env.SYNORA_TEST_PREPARED_WINDOWS_QA!);
  expect(directory).toMatch(
    /^C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-[A-Za-z0-9]+$/,
  );
  const workspace = join(directory, "workspace");
  const prefix = `synora-cancel-${randomUUID()}`;
  const scriptPath = join(workspace, `${prefix}.ps1`);
  const parentFile = join(workspace, `${prefix}-parent.pid`);
  const childFile = join(workspace, `${prefix}-child.pid`);
  const completedFile = join(workspace, `${prefix}-completed.txt`);
  const psQuote = (s: string) => "'" + s.replaceAll("'", "''") + "'";
  const script = `$ErrorActionPreference='Stop'\n$PID | Set-Content -Encoding ASCII -LiteralPath ${psQuote(parentFile)}\n$synoraSleeper=Start-Process powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 20' -NoNewWindow -PassThru\n$synoraSleeper.Id | Set-Content -Encoding ASCII -LiteralPath ${psQuote(childFile)}\nWrite-Output 'SYNORA_CANCEL_READY'\n$synoraSleeper.WaitForExit()\nSet-Content -LiteralPath ${psQuote(completedFile)} -Value 'SHOULD_NOT_FINISH'\n`;
  await writeFile(scriptPath, script, { flag: "wx" });
  await mkdir("out/live-evidence", { recursive: true });
  const run = promisify(execFile);
  const rows = async () => {
    const result = await run(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress",
      ],
      { timeout: 5000, windowsHide: true },
    );
    return JSON.parse(result.stdout) as {
      ProcessId: number;
      ParentProcessId: number;
      CreationDate: string;
    }[];
  };
  let app: ElectronApplication | undefined;
  let page!: Page;
  let last: EngineSnapshot | undefined;
  const errors: string[] = [];
  const observed: { pid: number; created: string }[] = [];
  const launch = async () => {
    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: ["--disable-gpu"],
      cwd: process.cwd(),
      chromiumSandbox: true,
      env: { ...process.env, SYNORA_DATA_DIR: join(directory, "state") },
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
  const snapshot = async () => {
    last = await page.evaluate(async () => {
      const r = await window.synora.engineSnapshot();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
    if (last.status === "failed") throw Error(JSON.stringify(last.error));
    return last;
  };
  try {
    await launch();
    // Cold recovery must finish before changing the active conversation.
    await expect
      .poll(async () => (await snapshot()).status, { timeout: 30000 })
      .toBe("completed");
    await nav("New conversation");
    await nav("Workspace");
    const command = `powershell.exe -NoProfile -ExecutionPolicy RemoteSigned -File ${JSON.stringify(scriptPath)}`;
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        `Use exec_command to run exactly this local PowerShell cancellation fixture: ${command}. It creates only its own PID markers and sleeps twenty seconds. Do not use network, agents or other tools or change the script. Wait for the command; the operator will interrupt it.`,
      );
    await nav("Send message");
    await expect
      .poll(
        async () => {
          const s = await snapshot();
          if (s.approval)
            throw Error(
              "Unexpected approval for owned sandboxed cancellation test",
            );
          return s.items.some(
            (i) => i.type === "commandExecution" && i.status === "inProgress",
          );
        },
        { timeout: 60000, intervals: [50, 100, 200] },
      )
      .toBe(true);
    for (const path of [parentFile, childFile]) {
      await expect
        .poll(() => readFile(path, "utf8").catch(() => ""), {
          timeout: 8000,
          intervals: [50, 100],
        })
        .toMatch(/^\d+\r?\n$/);
      const pid = Number((await readFile(path, "utf8")).trim());
      const processes = await rows();
      const owned = new Set([app!.process().pid!]);
      for (;;) {
        const size = owned.size;
        for (const row of processes)
          if (owned.has(row.ParentProcessId)) owned.add(row.ProcessId);
        if (owned.size === size) break;
      }
      expect(
        owned.has(pid),
        "marker PID must belong to this app process tree",
      ).toBe(true);
      const actual = processes.find((p) => p.ProcessId === pid)!;
      expect(actual.CreationDate).toBeTruthy();
      observed.push({ pid, created: actual.CreationDate });
    }
    const running = await snapshot();
    const item = running.items.find(
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
    expect(interrupted.sessionId).toBe(running.sessionId);
    expect(interrupted.turnId).toBe(running.turnId);
    await expect
      .poll(
        async () =>
          (await rows()).filter((p) =>
            observed.some(
              (o) => o.pid === p.ProcessId && o.created === p.CreationDate,
            ),
          ),
        { timeout: 8000 },
      )
      .toEqual([]);
    await expect
      .poll(async () => {
        const i = (await snapshot()).items.find((v) => v.id === item.id);
        return (
          i?.type === "commandExecution" &&
          ["completed", "failed", "declined"].includes(i.status)
        );
      })
      .toBe(true);
    await expect(access(completedFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await readFile(scriptPath, "utf8")).toBe(script);
    await expect(page.getByLabel("Reasoning profile")).toBeEnabled();
    await page
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
    const replies = resumed.items.filter(
      (entry) => entry.type === "agentMessage",
    );
    expect(replies).toHaveLength(1);
    const resumedIdentity = {
      conversationId: resumed.conversationId,
      sessionId: resumed.sessionId,
      threadId: resumed.threadId,
      turnId: resumed.turnId,
      messageId: replies[0].id,
    };
    await assertResumedAssistant(page, resumed, resumedIdentity);
    await app!.close();
    app = undefined;
    await launch();
    await expect
      .poll(() => snapshot(), { timeout: 30000 })
      .toMatchObject({
        connection: "live",
        status: "completed",
        sessionId: running.sessionId,
        threadId: resumed.threadId,
        turnId: resumed.turnId,
      });
    await expect(page.locator(`[data-item-id="${item.id}"]`)).toHaveCount(1);
    await assertResumedAssistant(page, await snapshot(), resumedIdentity);
    expect(errors).toEqual([]);
    await writeFile(
      "out/live-evidence/cancel-native-win32.json",
      JSON.stringify(
        {
          passed: true,
          directory,
          scriptPath,
          script,
          observed,
          running,
          interrupted,
          resumed,
          resumedIdentity,
          restored: await snapshot(),
          cancelledAt,
          errors,
        },
        null,
        2,
      ),
    );
  } catch (e) {
    await writeFile(
      "out/live-evidence/cancel-native-win32-failure.json",
      JSON.stringify(
        { directory, last, observed, errors, failure: String(e) },
        null,
        2,
      ),
    );
    throw e;
  } finally {
    await app?.close();
  }
});
