import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { sha256File } from "../src/engine/core-runtime";

test("Windows providers reuse the existing original sandbox without credential rotation or lost history", async () => {
  expect(process.platform).toBe("win32");
  const directory = resolve(process.env.SYNORA_TEST_PREPARED_WINDOWS_QA!);
  expect(directory).toMatch(
    /^C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-[A-Za-z0-9]+$/,
  );
  const state = join(directory, "state");
  const legacy = join(state, "app-server", "native-axiom");
  const credentialFile = join(legacy, ".sandbox-secrets", "sandbox_users.json");
  const credentialHash = await sha256File(credentialFile);
  const originalMarker = await sha256File(
    join(legacy, ".sandbox", "setup_marker.json"),
  );
  let app: ElectronApplication | undefined, page: Page;
  const errors: string[] = [],
    ids: string[] = [];
  const launch = async () => {
    app = await _electron.launch({
      args: [".", "--disable-gpu"],
      chromiumSandbox: true,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_DATA_DIR: state },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    const startupState = await page.evaluate(() => window.synora.state());
    if (!startupState.ok) throw Error(startupState.error.message);
    if (startupState.value.engine.mode === "simulated") {
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByLabel("Engine provider").selectOption("native-axiom");
      await page
        .getByRole("button", { name: "Read live model catalog", exact: true })
        .click();
      await expect(page.getByLabel("Engine model")).toBeEnabled();
      await page
        .getByRole("button", { name: "Use live Axiom", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Workspace", exact: true })
        .click();
    }
  };
  const snapshot = () =>
    page.evaluate(async () => {
      const r = await window.synora.engineSnapshot();
      if (!r.ok) throw Error(r.error.message);
      if (r.value.status === "failed")
        throw Error(JSON.stringify(r.value.error));
      return r.value;
    });
  const stable = () =>
    expect
      .poll(async () => (await snapshot()).status, { timeout: 45000 })
      .toBe("completed");
  const ready: Record<string, unknown> = {};
  try {
    await launch();
    await stable();
    const before = await snapshot();
    expect(before.threadId).toBeTruthy();
    const beforeState = await page!.evaluate(async () => {
      const r = await window.synora.state();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
    const workspace = beforeState.workspaces.find(
      (w) => w.path === join(directory, "workspace"),
    )!;
    expect(workspace).toBeTruthy();
    for (const type of ["openai", "xai"] as const) {
      const id = `home-${type}-${randomUUID()}`;
      ids.push(id);
      const result = await page!.evaluate(
        ({ id, type }) =>
          window.synora.integrationSave({
            id,
            kind: "provider",
            providerType: type,
            name: `QA ${type} shared native home`,
            endpoint:
              type === "openai"
                ? "https://api.openai.com/v1"
                : "http://127.0.0.1:49151/v1",
            auth: type === "openai" ? "core-account" : "api-key",
            enabled: true,
            tools: [],
          }),
        { id, type },
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    for (const id of ["native-axiom", ...ids]) {
      const result = await page!.evaluate(
        ({ id, workspace }) => window.synora.engineNativeSetup(id, workspace),
        { id, workspace: workspace.id },
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
      if (!result.ok) throw Error(result.error.message);
      expect(result.value.status).toBe("ready");
      ready[id] = result.value;
    }
    const binding = JSON.parse(
      await readFile(join(state, "app-server", ".windows-home.json"), "utf8"),
    );
    expect(binding.relative).toBe("app-server/native-axiom");
    expect(await sha256File(credentialFile)).toBe(credentialHash);
    expect(
      await sha256File(join(legacy, ".sandbox", "setup_marker.json")),
    ).toBe(originalMarker);
    await app!.close();
    app = undefined;
    await launch();
    await stable();
    const restored = await snapshot();
    expect(restored.threadId).toBe(before.threadId);
    expect(restored.sessionId).toBe(before.sessionId);
    for (const item of before.items)
      expect(restored.items.some((i) => i.id === item.id)).toBe(true);
    // Leave only our QA app in simulator mode, ready for offline provider tests;
    // retain all real bound conversations and their histories.
    await page!.getByRole("button", { name: "Settings", exact: true }).click();
    await page!
      .getByRole("button", { name: "Use simulator", exact: true })
      .click();
    await expect
      .poll(async () => {
        const r = await page!.evaluate(() => window.synora.state());
        return r.ok ? r.value.engine.mode : r.error;
      })
      .toBe("simulated");
    for (const id of ids) {
      const result = await page!.evaluate(
        (id) => window.synora.integrationDelete(id),
        id,
      );
      expect(result.ok, JSON.stringify(result)).toBe(true);
    }
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/windows-shared-home.json",
      JSON.stringify(
        {
          passed: true,
          scope:
            "Original Core readiness for three provider identities and real cold history; no inference or setupStart",
          directory,
          binding,
          ready,
          before,
          restored,
          credentialHash,
          originalMarker,
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
