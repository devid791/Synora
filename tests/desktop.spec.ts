import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer, type Server } from "node:http";
import { terminalMarker } from "./terminal-fixture";

test("Desktop local workflows, isolation, persistence, terminal and browser", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synora-desktop-")),
    workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(
    path.join(workspace, "hello.txt"),
    "Hello from a real file",
  );
  let app: ElectronApplication | undefined, server: Server | undefined;
  const errors: string[] = [];
  const launch = async () => {
    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: process.env.SYNORA_TEST_EXECUTABLE
        ? ["--disable-gpu"]
        : [".", "--disable-gpu"],
      chromiumSandbox: true,
      cwd: process.cwd(),
      env: { ...process.env, SYNORA_DATA_DIR: path.join(dir, "state") },
    });
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    return page;
  };
  const nav = async (page: Page, label: string) => {
    await page.getByRole("button", { name: label, exact: true }).click();
  };
  try {
    let page = await launch();
    await expect(
      page.getByRole("heading", { name: "A space for focused work." }),
    ).toBeVisible();
    const isolation = await app!.evaluate(({ BrowserWindow }) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      const p = (
        wc as unknown as { getLastWebPreferences(): Electron.WebPreferences }
      ).getLastWebPreferences();
      return {
        sandbox: p.sandbox,
        isolation: p.contextIsolation,
        node: p.nodeIntegration,
        url: wc.getURL(),
      };
    });
    expect(isolation).toEqual({
      sandbox: true,
      isolation: true,
      node: false,
      url: "synora://app/index.html",
    });
    if (process.platform === "linux") {
      const pid = await app!.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].webContents.getOSProcessId(),
      );
      const status = await fs.readFile(`/proc/${pid}/status`, "utf8");
      expect(status).toMatch(/NoNewPrivs:\s+1/);
      expect(status).toMatch(/Seccomp:\s+2/);
    }
    expect(
      await page.evaluate(() => ({
        node: typeof (window as any).require,
        invoke: typeof (window.synora as any).invoke,
      })),
    ).toEqual({ node: "undefined", invoke: "undefined" });
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selected],
      })) as typeof dialog.showOpenDialog;
    }, workspace);
    await page
      .getByRole("button", { name: "Add workspace", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "hello.txt", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "hello.txt", exact: true }).click();
    await expect(
      page.getByRole("textbox", { name: "File contents" }),
    ).toHaveValue("Hello from a real file");
    await page
      .getByRole("textbox", { name: "File contents" })
      .fill("Saved from Synora UI");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect
      .poll(() => fs.readFile(path.join(workspace, "hello.txt"), "utf8"))
      .toBe("Saved from Synora UI");
    await page.getByRole("button", { name: "Close editor" }).click();
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Hello simulator");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page.locator(".message.assistant")).toContainText(
      "Synora foundation is ready.",
    );
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.synora.engineSnapshot();
          return r.ok ? r.value.status : "error";
        }),
      )
      .toBe("completed");
    const turnStatus = () =>
      page.evaluate(async () => {
        const r = await window.synora.engineSnapshot();
        return r.ok ? r.value.status : "error";
      });
    for (const scenario of [
      "tool",
      "approval",
      "failure",
      "slow",
      "disconnect",
    ]) {
      await page.getByLabel("Simulation scenario").selectOption(scenario);
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill(`Exercise ${scenario}`);
      await page.getByRole("button", { name: "Send message" }).click();
      if (scenario === "approval") {
        await expect(page.locator(".approval")).toBeVisible();
        await page
          .getByRole("button", { name: "Approve simulation", exact: true })
          .click();
      }
      if (scenario === "slow")
        await page
          .getByRole("button", { name: "Cancel turn", exact: true })
          .click();
      if (scenario === "disconnect") {
        await expect(
          page.getByRole("button", { name: "Reconnect", exact: true }),
        ).toBeVisible();
        await expect.poll(turnStatus).toBe("completed");
        await page
          .getByRole("button", { name: "Reconnect", exact: true })
          .click();
      }
      await expect
        .poll(turnStatus)
        .toBe(
          scenario === "failure"
            ? "failed"
            : scenario === "slow"
              ? "interrupted"
              : "completed",
        );
      if (scenario === "tool")
        await expect(page.locator(".tool-call")).toContainText("read_file");
    }
    await page.getByLabel("Simulation scenario").selectOption("agents");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Show the agents");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.synora.engineSnapshot();
          return r.ok ? r.value.status : "error";
        }),
      )
      .toBe("completed");
    await nav(page, "Agents");
    await expect(page.locator(".card")).toHaveCount(2);
    await expect(page.locator(".card").first()).toContainText("Astra");
    await expect(page.locator(".card").last()).toContainText("Vega");
    await nav(page, "Bots");
    await page.getByRole("button", { name: "New bot", exact: true }).click();
    await page.getByLabel("Bot name").fill("QA Reviewer");
    await page
      .getByLabel("Bot instructions")
      .fill("Review this workspace carefully.");
    await page.getByRole("button", { name: "Save preset" }).click();
    await expect(page.getByRole("region", { name: "My bots", exact: true }).locator("[data-bot-id]")).toContainText("QA Reviewer");
    const presetPath = path.join(dir, "reviewer.json");
    await app!.evaluate(({ dialog }, target) => {
      dialog.showSaveDialog = (async () => ({
        canceled: false,
        filePath: target,
      })) as typeof dialog.showSaveDialog;
    }, presetPath);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await expect
      .poll(async () => {
        try {
          return JSON.parse(await fs.readFile(presetPath, "utf8")).schema;
        } catch {
          return "";
        }
      })
      .toBe("synora.bot.v1");
    await page
      .getByRole("button", { name: "Delete preset", exact: true })
      .click();
    await page.getByRole("dialog", { name: "Delete preset", exact: true })
      .getByRole("button", { name: "Delete preset", exact: true }).click();
    await expect(page.getByRole("region", { name: "My bots", exact: true }).locator("[data-bot-id]")).toHaveCount(0);
    await app!.evaluate(({ dialog }, target) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [target],
      })) as typeof dialog.showOpenDialog;
    }, presetPath);
    await page
      .getByRole("button", { name: "Import JSON", exact: true })
      .click();
    await expect(page.getByRole("region", { name: "My bots", exact: true }).locator("[data-bot-id]")).toContainText("QA Reviewer");
    for (const label of [
      "Models & accounts",
      "Connectors",
      "Plugins & MCP",
      "Telemetry & backend",
      "Settings",
    ])
      await nav(page, label);
    // Preferences acknowledge async storage before changing the controlled
    // checkbox. Assert the acknowledged result, not the click's immediate DOM.
    await page.getByLabel("Compact interface").click();
    await expect(page.getByLabel("Compact interface")).toBeChecked();
    await expect(page.locator(".app")).toHaveClass(/compact/);
    await nav(page, "Models & accounts");
    // A fresh profile checks Core account state on first navigation. Provider
    // mutations must wait for that real operation, not race its idle guard.
    await expect(page.getByRole("article", { name: "OpenAI account", exact: true }))
      .toContainText("Account checked", { timeout: 20000 });
    await page.getByRole("button", { name: "Add configuration" }).click();
    await page.getByLabel("Configuration ID").fill("local-provider");
    await page.getByLabel("Configuration name").fill("Local provider");
    await page
      .getByLabel("Configuration endpoint")
      .fill("http://127.0.0.1:18000/v1");
    await page.getByRole("button", { name: "Save configuration" }).click();
    await expect(page.locator(".card").filter({has: page.getByText("Local provider", {exact:true})})).toContainText("Disabled");
    await page.getByRole("button", { name: "Toggle terminal" }).click();
    await page
      .getByRole("button", { name: "New terminal", exact: true })
      .click();
    await expect(page.locator(".xterm")).toBeVisible();
    // Type through the real xterm input path, not a mocked terminal result.
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(terminalMarker("SYNORA_UI_PTY") + "\r");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.synora.terminalList();
          return r.ok ? r.value[0]?.output : "";
        }),
      )
      .toContain("SYNORA_UI_PTY");
    const pid = await page.evaluate(async () => {
      const r = await window.synora.terminalList();
      return r.ok ? r.value[0].pid : 0;
    });
    await page.getByRole("button", { name: "Stop terminal" }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.synora.terminalList();
          return r.ok ? r.value[0].status : "";
        }),
      )
      .toBe("exited");
    expect(() => process.kill(pid, 0)).toThrow();
    await page.getByRole("button", { name: "Toggle terminal" }).click();
    server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(
        "<!doctype html><title>Synora isolation fixture</title><h1>Local browser fixture</h1><script>window.inspected={node:typeof require,api:typeof window.synora};</script>",
      );
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}/`;
    await nav(page, "Browser");
    await page.getByLabel("Browser address").fill(url);
    await page.getByRole("button", { name: "Go", exact: true }).click();
    await expect(page.locator(".tabs")).toContainText(
      "Synora isolation fixture",
    );
    const browserIsolation = await app!.evaluate(
      async ({ webContents }, target) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getURL() === target)!;
        const prefs = (
          wc as unknown as { getLastWebPreferences(): Electron.WebPreferences }
        ).getLastWebPreferences();
        return {
          sandbox: prefs.sandbox,
          node: prefs.nodeIntegration,
          preload: prefs.preload ?? null,
          inspection: await wc.executeJavaScript("window.inspected"),
        };
      },
      url,
    );
    expect(browserIsolation).toEqual({
      sandbox: true,
      node: false,
      preload: null,
      inspection: { node: "undefined", api: "undefined" },
    });
    expect(
      await page.evaluate(async () => {
        const r = await window.synora.browserOpen("file:///etc/passwd");
        return r.ok;
      }),
    ).toBe(false);
    await page.getByRole("button", { name: "Close browser tab" }).click();
    await expect(
      page.getByRole("heading", { name: "Your browser, in the workspace." }),
    ).toBeVisible();
    await nav(page, "Workspace");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Draft survives restart");
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.synora.state();
          return r.ok
            ? r.value.conversations.some(
                (c) => c.draft === "Draft survives restart",
              )
            : false;
        }),
      )
      .toBe(true);
    await page.screenshot({ path: "test-results/desktop-workspace.png" });
    // Quit immediately after an edit; the close handshake must flush the debounce.
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Immediate close retains this draft");
    await app!.close();
    app = undefined;
    page = await launch();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue("Immediate close retains this draft");
    await expect(page.locator(".app")).toHaveClass(/compact/);
    await nav(page, "Bots");
    await expect(page.getByRole("region", { name: "My bots", exact: true }).locator("[data-bot-id]")).toContainText("QA Reviewer");
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    if (server)
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    await fs.rm(dir, { recursive: true });
  }
});

test("Desktop dirty-file close, stale edits, browser rejection and compact window remain safe", async () => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "synora-desktop-negative-"),
  );
  const workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "note.txt"), "original");
  let app: ElectronApplication | undefined;
  let fixture: Server | undefined;
  try {
    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: process.env.SYNORA_TEST_EXECUTABLE
        ? ["--disable-gpu"]
        : [".", "--disable-gpu"],
      cwd: process.cwd(),
      chromiumSandbox: true,
      env: { ...process.env, SYNORA_DATA_DIR: path.join(dir, "state") },
    });
    const page = await app.firstWindow();
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    await app.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selected],
      })) as typeof dialog.showOpenDialog;
    }, workspace);
    await page.getByRole("button", { name: "Add workspace" }).click();
    await page.getByRole("button", { name: "note.txt", exact: true }).click();
    await page.getByLabel("File contents").fill("unsaved draft");
    await page
      .getByRole("button", { name: "New conversation", exact: true })
      .click();
    await expect(page.locator(".notice.error")).toContainText("Save or reload");
    await expect(page.getByLabel("File contents")).toHaveValue("unsaved draft");
    await fs.writeFile(path.join(workspace, "note.txt"), "external edit");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator(".notice.error")).toBeVisible();
    expect(await fs.readFile(path.join(workspace, "note.txt"), "utf8")).toBe(
      "external edit",
    );
    await app.evaluate(({ dialog, app }) => {
      (globalThis as any).qaCloseCount = 0;
      dialog.showMessageBox = (async () => {
        (globalThis as any).qaCloseCount++;
        return { response: 0, checkboxChecked: false };
      }) as typeof dialog.showMessageBox;
      app.quit();
    });
    await expect
      .poll(() => app!.evaluate(() => (globalThis as any).qaCloseCount))
      .toBe(1);
    await expect(page.getByLabel("File contents")).toHaveValue("unsaved draft");
    // Replace the dialog decision only, not the close/draft/PTY lifecycle implementation.
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = (async () => ({
        response: 1,
        checkboxChecked: false,
      })) as typeof dialog.showMessageBox;
    });
    await app.close();
    app = undefined;
    expect(await fs.readFile(path.join(workspace, "note.txt"), "utf8")).toBe(
      "external edit",
    );

    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: process.env.SYNORA_TEST_EXECUTABLE
        ? ["--disable-gpu"]
        : [".", "--disable-gpu"],
      cwd: process.cwd(),
      chromiumSandbox: true,
      env: { ...process.env, SYNORA_DATA_DIR: path.join(dir, "state") },
    });
    const reopened = await app.firstWindow();
    await expect(reopened.getByLabel("Active workspace")).not.toHaveValue("");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setSize(900, 640),
    );
    await reopened
      .getByRole("button", { name: "Settings", exact: true })
      .click();
    await expect(reopened.getByLabel("Compact interface")).toBeVisible();
    expect(
      await reopened.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    fixture = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end("<title>Negative browser fixture</title><h1>Fixture</h1>");
    });
    await new Promise<void>((r) => fixture!.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(fixture.address() as { port: number }).port}/`;
    await reopened
      .getByRole("button", { name: "Browser", exact: true })
      .click();
    await reopened.getByLabel("Browser address").fill(url);
    await reopened.getByRole("button", { name: "Go", exact: true }).click();
    await expect(reopened.locator(".tabs")).toContainText(
      "Negative browser fixture",
    );
    const flags = await app.evaluate(async ({ webContents }, url) => {
      const wc = webContents
        .getAllWebContents()
        .find((w) => w.getURL() === url)!;
      return wc.executeJavaScript(
        `(async()=>{const status=await navigator.permissions.query({name:'geolocation'});const popup=window.open('https://example.invalid/');return {permission:status.state,popupBlocked:popup===null};})()`,
      );
    }, url);
    expect(flags).toEqual({ permission: "denied", popupBlocked: true });
    await expect(reopened.locator(".notice")).toContainText(
      "popup was blocked",
    );
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://user:password@example.invalid/",
    ]) {
      expect(
        await reopened.evaluate(
          async (u) => (await window.synora.browserOpen(u)).ok,
          url,
        ),
      ).toBe(false);
    }
    await reopened.getByRole("button", { name: "Close browser tab" }).click();
  } finally {
    if (app) {
      await app
        .evaluate(({ dialog }) => {
          dialog.showMessageBox = (async () => ({
            response: 1,
            checkboxChecked: false,
          })) as typeof dialog.showMessageBox;
        })
        .catch(() => {});
      await app.close();
    }
    if (fixture) await new Promise<void>((r) => fixture!.close(() => r()));
    await fs.rm(dir, { recursive: true });
  }
});
