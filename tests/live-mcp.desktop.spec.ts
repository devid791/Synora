import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import type { EngineSnapshot } from "../src/shared/contracts";
import { qualificationRuntime } from "./fixtures/qualification-runtime";

test("Packaged native web tools: actual model search/fetch, bundled executor, cold identity and disabled catalog", async () => {
  const prepared = process.env.SYNORA_TEST_PREPARED_WINDOWS_QA;
  if (prepared) {
    expect(process.platform).toBe("win32");
    expect(resolve(prepared)).toMatch(
      /^C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-[A-Za-z0-9]+$/,
    );
  }
  const directory = prepared
    ? resolve(prepared)
    : await mkdtemp(join(await realpath(tmpdir()), "synora-packaged-web-"));
  const workspace = join(directory, "workspace"),
    state = join(directory, "state");
  if (!prepared) await mkdir(workspace);
  let app: ElectronApplication | undefined, page: Page;
  let lastSnapshot: EngineSnapshot | undefined;
  const errors: string[] = [];
  const executable = process.env.SYNORA_TEST_EXECUTABLE!;
  const resources =
    process.platform === "darwin"
      ? resolve(dirname(executable), "../Resources")
      : join(dirname(executable), "resources");
  const launch = async () => {
    app = await _electron.launch({
      executablePath: executable,
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
  const catalogIdle = async () => {
    // Connectors starts a real catalog read on entry. Null is not ready: wait
    // for its first completed snapshot and owned process cleanup before edits.
    await expect.poll(async () => page.evaluate(async () => {
      const result = await window.synora.coreCatalogStatus();
      if (!result.ok) throw Error(result.error.message);
      if (result.value?.cleanupFailed) throw Error("Catalog cleanup failed");
      return !!result.value?.completedAt && !result.value.busy;
    }), { timeout: 90000 }).toBe(true);
    await expect(page.getByRole("button", { name: "Read Core catalog", exact: true })).toBeEnabled();
  };
  const snapshot = async () => {
    lastSnapshot = await page.evaluate(async () => {
      const result = await window.synora.engineSnapshot();
      if (!result.ok) throw Error(result.error.message);
      return result.value;
    });
    return lastSnapshot;
  };
  const complete = async () => {
    await expect
      .poll(
        async () => {
          const s = await snapshot();
          if (s.status === "failed") throw Error(JSON.stringify(s.error));
          if (s.approval || s.questions?.some((q) => q.params.isBlocking))
            throw Error(
              "Unexpected interactive request in read-only web qualification",
            );
          return s.status;
        },
        { timeout: 120000 },
      )
      .toBe("completed");
  };
  try {
    await launch();
    if (prepared) {
      await nav("New conversation");
      expect((await snapshot()).threadId).toBeFalsy();
      await nav("Workspace");
      const workspaceId = await page!.evaluate(async (path) => {
        const result = await window.synora.state();
        if (!result.ok) throw Error(result.error.message);
        return result.value.workspaces.find((entry) => entry.path === path)?.id;
      }, workspace);
      expect(workspaceId, "reuse only the prepared QA workspace").toBeTruthy();
      await page!.getByLabel("Active workspace").selectOption(workspaceId!);
    } else {
      await app!.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({
          canceled: false,
          filePaths: [path],
        })) as typeof dialog.showOpenDialog;
      }, workspace);
      await nav("Add workspace");
      await nav("Models & accounts");
      await expect(page!.getByRole("article", { name: "OpenAI account", exact: true }))
        .toContainText("Account checked", { timeout: 20000 });
      await nav("Add configuration");
      await page!.getByLabel("Configuration ID").fill("native-axiom");
      await page!
        .getByLabel("Configuration name")
        .fill("Native Axiom web qualification");
      await page!
        .getByLabel("Configuration endpoint")
        .fill(process.env.SYNORA_TEST_ENDPOINT!);
      await page!.getByLabel("Enable configuration").check();
      await nav("Save configuration");
      await expect(page!.getByRole("dialog")).toHaveCount(0);
    }
    await nav("Connectors");
    await catalogIdle();
    const card = () =>
      page
        .locator("article.card")
        .filter({ hasText: "Packaged web qualification" });
    const existing = await page!.evaluate(async () => {
      const result = await window.synora.state();
      if (!result.ok) throw Error(result.error.message);
      return result.value.integrations.find(
        (entry) => entry.id === "native-web",
      );
    });
    if (existing) {
      // Prepared Windows state retains the previous successful run's disabled
      // connector. Edit that exact QA configuration; duplicate creation must
      // remain an error and must never be mistaken for a successful save.
      expect(prepared).toBeTruthy();
      expect(existing.kind).toBe("connector");
      expect(existing.name).toBe("Packaged web qualification");
      expect(existing.executor).toBe("searxng");
      await card().getByRole("button", { name: "Edit", exact: true }).click();
    } else {
      await nav("Add configuration");
      await page!.getByLabel("Configuration ID").fill("native-web");
    }
    await page!
      .getByLabel("Configuration name")
      .fill("Packaged web qualification");
    await page!.getByLabel("Integration executor").selectOption("searxng");
    await page!
      .getByLabel("Configuration endpoint")
      .fill(process.env.SYNORA_TEST_SEARCH_URL!);
    await expect(page!.getByLabel("Declared tools")).toBeDisabled();
    await page!.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await expect(page!.getByLabel("Configuration name")).toHaveCount(0);
    expect(
      await page!.evaluate(async () => {
        const result = await window.synora.state();
        if (!result.ok) throw Error(result.error.message);
        return result.value.integrations.find(
          (entry) => entry.id === "native-web",
        )?.enabled;
      }),
    ).toBe(true);
    await expect(card()).toContainText("Not connected");
    await expect(card()).toContainText("0 mounted tools");
    await nav("Settings");
    await page!.getByLabel("Engine provider").selectOption("native-axiom");
    await nav("Read live model catalog");
    await nav("Use live Axiom");
    await expect(page!.locator(".engine-settings")).toContainText(
      "Current mode: Axiom",
    );
    await nav("Workspace");
    await page!
      .getByLabel("Message", { exact: true })
      .fill(
        "Use your mounted web_search tool to search IANA reserved example domains. Then use web_fetch to read an IANA URL from those actual search results. No shell or other network tools. Reply with one sentence about the purpose of the domains and the fetched URL, based on the actual tool results. Do not claim success unless both tools succeeded.",
      );
    await nav("Send message");
    await complete();
    const completed = await snapshot();
    const calls = completed.items.filter((i) => i.type === "mcpToolCall");
    const search = calls.find((c) => c.tool === "web_search");
    const fetched = calls.find((c) => c.tool === "web_fetch");
    expect(search).toBeTruthy();
    expect(fetched).toBeTruthy();
    const payload = (call: NonNullable<typeof search>) => {
      expect(call.status).toBe("completed");
      expect(call.error).toBeNull();
      const text = call.result?.content.find(
        (v) =>
          v && typeof v === "object" && !Array.isArray(v) && v.type === "text",
      ) as { text: string };
      expect(typeof text?.text).toBe("string");
      return JSON.parse(text.text);
    };
    const found = payload(search!),
      document = payload(fetched!);
    expect(found.http_status).toBe(200);
    expect(document.http_status).toBe(200);
    expect(
      found.results.some((r: { url: string }) => r.url === document.url),
    ).toBe(true);
    expect(new URL(document.url).hostname).toMatch(/(^|\.)iana\.org$/);
    expect(document.content.length).toBeGreaterThan(100);
    expect(
      completed.items
        .filter((v) => v.type === "agentMessage")
        .some((v) => v.text.includes(document.url)),
    ).toBe(true);
    expect(completed.items.some((v) => v.type === "commandExecution")).toBe(
      false,
    );
    expect(completed.firstDeltaAt).toBeLessThan(completed.completedAt!);
    expect(completed.backendRequests!.length).toBeGreaterThan(0);
    for (const r of completed.backendRequests!)
      expect(r.sessionId).toBe(completed.sessionId);
    const executor = completed.mcpServers?.find(
      (s) => s.name === "synora_native_web",
    );
    expect(executor?.runtimeStatus).toBe("connected");
    expect(
      Object.values(executor!.tools)
        .map((t) => t!.name)
        .sort(),
    ).toEqual(["web_fetch", "web_search"]);
    for (const call of calls) {
      const row = page!.locator(`[data-item-id="${call.id}"]`);
      await expect(row).toHaveCount(1);
      await expect(row).toContainText("Live");
      await expect(row).toContainText("Tool result · untrusted content");
      expect(await row.locator("script, iframe, object").count()).toBe(0);
    }
    const manifest = JSON.parse(
      await readFile(
        join(
          resources,
          "native",
          `${process.platform}-${process.arch}`,
          "web-mcp-manifest.json",
        ),
        "utf8",
      ),
    );
    const helperName =
      process.platform === "win32" ? "synora-web-mcp.exe" : "synora-web-mcp";
    const helpers = (await readdir(state, { recursive: true })).filter((p) =>
      p.endsWith(helperName),
    );
    expect(helpers).toHaveLength(1);
    const helperHash = createHash("sha256")
      .update(await readFile(join(state, helpers[0])))
      .digest("hex");
    expect(helperHash).toBe(manifest.sha256);
    await nav("Connectors");
    await catalogIdle();
    await expect(card()).toContainText("2 mounted tools");
    await card().getByText("Core tool catalog", { exact: true }).click();
    await expect(card().getByText("web_search", { exact: true })).toBeVisible();
    await expect(card().getByText("web_fetch", { exact: true })).toBeVisible();
    await nav("Workspace");
    await app!.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      w.setContentSize(1000, 740);
      w.webContents.setZoomFactor(1.5);
    });
    for (const call of calls) {
      const row = page!.locator(`[data-item-id="${call.id}"]`);
      await row.locator("strong").scrollIntoViewIfNeeded();
      await expect(row.locator("strong")).toBeVisible();
    }
    expect(
      await page!.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await mkdir("test-results/live-mcp-native", { recursive: true });
    const png = await app!.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(
      "test-results/live-mcp-native/actual-tools-150.png",
      Buffer.from(png, "base64"),
    );
    await app!.close();
    app = undefined;
    await launch();
    await expect
      .poll(async () => (await snapshot()).status, { timeout: 30000 })
      .toBe("completed");
    const restored = await snapshot();
    expect(restored.sessionId).toBe(completed.sessionId);
    expect(restored.threadId).toBe(completed.threadId);
    expect(restored.items.filter((v) => v.type === "mcpToolCall")).toEqual(
      calls,
    );
    expect(restored.backendRequests).toEqual(completed.backendRequests);
    for (const call of calls)
      await expect(page!.locator(`[data-item-id="${call.id}"]`)).toHaveCount(1);
    await nav("Connectors");
    await catalogIdle();
    await card().getByRole("button", { name: "Edit", exact: true }).click();
    await page!.getByLabel("Enable configuration").uncheck();
    await nav("Save configuration");
    await expect(card()).toContainText("Disabled");
    await expect(card()).toContainText("0 mounted tools");
    await nav("Workspace");
    await page!
      .getByLabel("Message", { exact: true })
      .fill("No tools. Reply exactly SYNORA_WEB_RESUMED.");
    await nav("Send message");
    await complete();
    const final = await snapshot();
    expect(final.sessionId).toBe(completed.sessionId);
    expect(final.threadId).toBe(completed.threadId);
    expect(final.mcpServers?.some((s) => s.name === "synora_native_web")).toBe(
      false,
    );
    await expect(page!.locator(".message.assistant").last()).toContainText(
      "SYNORA_WEB_RESUMED",
    );
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/web-mcp-native.json",
      JSON.stringify(
        {
          passed: true,
          directory,
          executable,
          scope:
            "Packaged native UI, original Core, actual Axiom search/fetch and session recovery",
          completed,
          restored,
          final,
          calls,
          helperHash,
          fetchedUrl: document.url,
          errors,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/web-mcp-native-failure.json",
      JSON.stringify(
        { directory, executable, lastSnapshot, error: String(error), errors },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await app?.close();
  }
});
