import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { sha256File } from "../src/engine/core-runtime";

test("Windows returns from controlled providers to actual Axiom with the original thread and native tool", async () => {
  expect(process.platform).toBe("win32");
  expect(process.env.SYNORA_QA_NETWORK_PROOF).toBeUndefined();
  const directory = resolve(process.env.SYNORA_TEST_PREPARED_WINDOWS_QA!);
  expect(directory).toMatch(
    /^C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-[A-Za-z0-9]+$/,
  );
  const dataRoot = join(directory, "state");
  const credential = join(
    dataRoot,
    "app-server/native-axiom/.sandbox-secrets/sandbox_users.json",
  );
  const credentialHash = await sha256File(credential);
  const markerFile = join(directory, "workspace/native-check.txt");
  const marker = await readFile(markerFile, "utf8");
  expect(marker).toBe("SYNORA_NATIVE_AFTER\n");
  let app: ElectronApplication | undefined, page: Page;
  const errors: string[] = [];
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const state = () =>
    page.evaluate(async () => {
      const r = await window.synora.state();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
  const snapshot = () =>
    page.evaluate(async () => {
      const r = await window.synora.engineSnapshot();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
  const completed = () =>
    expect
      .poll(
        async () => {
          const s = await snapshot();
          return s.status === "failed" ? s.error : s.status;
        },
        { timeout: 90000 },
      )
      .toBe("completed");
  try {
    app = await _electron.launch({
      args: [".", "--disable-gpu"],
      chromiumSandbox: true,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_DATA_DIR: dataRoot },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    const before = await state();
    expect(before.engine.mode).toBe("simulated");
    const provider = before.integrations.find((p) => p.id === "native-axiom")!;
    expect(provider.endpoint).toBe(process.env.SYNORA_TEST_ENDPOINT);
    const index = before.conversations.findIndex(
      (c) =>
        c.binding?.endpoint === provider.endpoint &&
        c.binding.cwd === join(directory, "workspace"),
    );
    expect(index).toBeGreaterThanOrEqual(0);
    expect(index).toBeLessThan(30);
    const conversation = before.conversations[index];
    await page.locator(".history button").nth(index).click();
    await nav("Settings");
    await page.getByLabel("Engine provider").selectOption(provider.id);
    await nav("Read live model catalog");
    await expect(page.getByLabel("Engine model")).toBeEnabled();
    await page
      .getByLabel("Engine model")
      .selectOption(conversation.binding!.model);
    await nav("Use live Axiom");
    await nav("Workspace");
    await completed();
    const restored = await snapshot();
    expect(restored.threadId).toBe(conversation.binding!.threadId);
    expect(restored.sessionId).toBe(conversation.binding!.sessionId);
    const priorIds = new Set(restored.items.map((i) => i.id));
    await page
      .getByLabel("Message", { exact: true })
      .fill(
        "Use the native shell tool to read native-check.txt in this workspace. Do not change files. After reading reply exactly SYNORA_PROVIDER_SWITCH_BACK_OK.",
      );
    await nav("Send message");
    await completed();
    const after = await snapshot();
    expect(after.threadId).toBe(restored.threadId);
    expect(after.sessionId).toBe(restored.sessionId);
    const tool = after.items.find(
      (i) =>
        !priorIds.has(i.id) &&
        i.type === "commandExecution" &&
        i.status === "completed",
    );
    expect(tool).toBeTruthy();
    expect(JSON.stringify(tool)).toContain("SYNORA_NATIVE_AFTER");
    expect(JSON.stringify(after.items)).toContain(
      "SYNORA_PROVIDER_SWITCH_BACK_OK",
    );
    expect(await readFile(markerFile, "utf8")).toBe(marker);
    expect(await sha256File(credential)).toBe(credentialHash);
    const afterState = await state();
    for (const c of before.conversations)
      expect(
        afterState.conversations.find((v) => v.id === c.id)?.binding,
      ).toEqual(c.binding);
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/windows-provider-recovery.json",
      JSON.stringify(
        {
          passed: true,
          scope:
            "Actual Axiom native tool after OpenAI/xAI provider switching; not public cloud inference",
          directory,
          restored,
          after,
          credentialHash,
          preservedConversations: before.conversations.length,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await app?.close();
  }
});
