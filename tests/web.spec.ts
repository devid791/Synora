import { test, expect } from "@playwright/test";
import { startWebService } from "../src/web/server";
import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { terminalMarker } from "./terminal-fixture";

test("Same web UI: files, simulator SSE, persisted identity, PTY and isolated interactive browser", async ({
  page,
}) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synora-web-ui-")),
    workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "hello.txt"), "Web fixture file");
  const server = await startWebService({
    storePath: path.join(dir, "state.sqlite"),
    assets: path.resolve("out/web/ui"),
    speed: 0.15,
  });
  let isolationProbe: unknown;
  const fixture = createServer((req, res) => {
    if (req.url === "/probe" && req.method === "POST") {
      let body = "";
      req.on("data", (b) => (body += b));
      req.on("end", () => {
        isolationProbe = JSON.parse(body);
        res.end("OK");
      });
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(
      `<!doctype html><title>Isolated web fixture</title><style>body{margin:0}input,button{height:40px}</style><input aria-label="Fixture input" id="field"><button onclick="document.title='Clicked '+document.getElementById('field').value">Apply</button><script>navigator.permissions.query({name:'geolocation'}).then(async permission=>{let serviceBlocked=false;try{await fetch(${JSON.stringify(server.url + "/api/bootstrap")});}catch{serviceBlocked=true;}await fetch('/probe',{method:'POST',body:JSON.stringify({node:typeof require,api:typeof window.synora,permission:permission.state,serviceBlocked})});});</script>`,
    );
  });
  await new Promise<void>((r) => fixture.listen(0, "127.0.0.1", r));
  const target = `http://127.0.0.1:${(fixture.address() as { port: number }).port}`;
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  try {
    await page.goto(server.url);
    await expect(
      page.getByRole("heading", { name: "A space for focused work." }),
    ).toBeVisible();
    expect(await page.evaluate(() => typeof window.synora)).toBe("undefined");
    await nav("Add workspace");
    await page.getByLabel("Service folder").fill(workspace);
    await nav("Open folder");
    await nav("hello.txt");
    await expect(page.getByLabel("File contents")).toHaveValue(
      "Web fixture file",
    );
    await page.getByLabel("File contents").fill("Edited in web UI");
    await nav("Save");
    await expect
      .poll(() => fs.readFile(path.join(workspace, "hello.txt"), "utf8"))
      .toBe("Edited in web UI");
    await nav("Close editor");
    await page.getByLabel("Message", { exact: true }).fill("Web simulation");
    await nav("Send message");
    await expect(page.locator(".message.assistant")).toContainText(
      "Synora foundation is ready.",
    );
    await expect
      .poll(() => server.service.engine.snapshot().status)
      .toBe("completed");
    for (const scenario of [
      "tool",
      "approval",
      "failure",
      "slow",
      "disconnect",
      "agents",
    ] as const) {
      await page.getByLabel("Simulation scenario").selectOption(scenario);
      await page.getByLabel("Message", { exact: true }).fill(`Web ${scenario}`);
      await nav("Send message");
      if (scenario === "approval") {
        await expect
          .poll(() => server.service.engine.snapshot().status)
          .toBe("waiting");
        await nav("Connectors");
        await nav("Add configuration");
        await page.getByLabel("Configuration ID").fill("pending-connector");
        await page.getByLabel("Configuration name").fill("Pending edits");
        await expect(
          page.getByRole("button", { name: "Save configuration" }),
        ).toBeDisabled();
        await expect(page.getByRole("dialog").getByRole("status")).toContainText(
          "Your edits are kept here",
        );
        await expect(page.getByLabel("Configuration name")).toHaveValue(
          "Pending edits",
        );
        expect(server.service.store.read().integrations).toHaveLength(0);
        await nav("Close configuration");
        await nav("Workspace");
        await nav("Approve simulation");
      }
      if (scenario === "slow") await nav("Cancel turn");
      const status =
        scenario === "slow"
          ? "interrupted"
          : scenario === "failure"
            ? "failed"
            : "completed";
      await expect
        .poll(() => server.service.engine.snapshot().status)
        .toBe(status);
      if (scenario === "disconnect") await nav("Reconnect");
      if (scenario === "tool")
        await expect(page.locator(".tool-call")).toContainText("read_file");
    }
    await nav("Agents");
    await expect(page.locator(".card")).toHaveCount(2);
    await expect(page.locator(".card").first()).toContainText("Astra");
    await nav("Models & accounts");
    // Wait for the first real Core account read before mutating providers.
    await expect(page.getByRole("article", { name: "OpenAI account", exact: true }))
      .toContainText("Account checked", { timeout: 20000 });
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("web-provider");
    await page.getByLabel("Configuration name").fill("Web provider");
    await nav("Save configuration");
    await nav("Edit");
    await expect(page.getByLabel("Configuration ID")).toHaveAttribute(
      "readonly",
      "",
    );
    await page.getByLabel("Configuration name").fill("Provider edited");
    await nav("Save configuration");
    expect(server.service.store.read().integrations).toHaveLength(1);
    await nav("Bots");
    await nav("New bot");
    await page.getByLabel("Bot name").fill("Web reviewer");
    await nav("Save preset");
    const downloadPromise = page.waitForEvent("download");
    await nav("Export");
    const download = await downloadPromise;
    const exported = JSON.parse(
      await fs.readFile((await download.path())!, "utf8"),
    );
    expect(exported.schema).toBe("synora.bot.v1");
    expect(exported.id).toBeUndefined();
    await nav("Delete preset");
    await page.getByRole("dialog", { name: "Delete preset", exact: true })
      .getByRole("button", { name: "Delete preset", exact: true }).click();
    await expect(page.getByRole("region", { name: "My bots", exact: true }).locator("[data-bot-id]")).toHaveCount(0);
    const chooser = page.waitForEvent("filechooser");
    await nav("Import JSON");
    await (
      await chooser
    ).setFiles({
      name: "preset.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(exported)),
    });
    await expect(page.getByRole("region", { name: "My bots", exact: true }).locator("[data-bot-id]")).toContainText("Web reviewer");
    const invalid = page.waitForEvent("filechooser");
    await nav("Import JSON");
    await (
      await invalid
    ).setFiles({
      name: "invalid.json",
      mimeType: "application/json",
      buffer: Buffer.from('{"schema":"invalid"}'),
    });
    await expect(page.getByRole("region", { name: "Your bot library.", exact: true })
      .getByRole("alert")).toContainText("synora.bot.v1");
    expect(server.service.store.read().presets).toHaveLength(1);
    await nav("Workspace");
    await nav("Toggle terminal");
    await nav("New terminal");
    await page.locator(".xterm-helper-textarea").focus();
    await page.keyboard.type(terminalMarker("WEB_UI_PTY") + "\r");
    await expect
      .poll(() => server.service.terminals.list()[0]?.output)
      .toContain("WEB_UI_PTY");
    const pid = server.service.terminals.list()[0].pid;
    await nav("Stop terminal");
    await expect
      .poll(() => server.service.terminals.list()[0].status)
      .toBe("exited");
    expect(() => process.kill(pid, 0)).toThrow();
    await nav("Toggle terminal");
    await nav("Browser");
    await page.getByLabel("Browser address").fill(target);
    await nav("Go");
    await expect(page.locator(".tabs")).toContainText("Isolated web fixture");
    await expect
      .poll(() => isolationProbe)
      .toEqual({
        node: "undefined",
        api: "undefined",
        permission: "denied",
        serviceBlocked: true,
      });
    const remote = page.getByAltText("Interactive isolated browser page");
    await expect(remote).toBeVisible();
    // Actual pointer/keyboard relay into a separate Chromium page, not a static preview.
    await remote.click({ position: { x: 50, y: 20 } });
    await page.keyboard.type("Synora");
    await remote.click({ position: { x: 220, y: 20 } });
    await expect(page.locator(".tabs")).toContainText("Clicked Synora");
    await page.getByLabel("Browser address").fill(server.url);
    await nav("Go");
    await expect(page.locator(".notice.error")).toContainText(
      "cannot be opened",
    );
    await page.getByLabel("Browser address").fill("file:///etc/passwd");
    await nav("Go");
    await expect(page.locator(".notice.error")).toBeVisible();
    await nav("Close browser tab");
    await nav("Workspace");
    await page.getByLabel("Message", { exact: true }).fill("Web restart draft");
    await expect
      .poll(() => server.service.store.read().conversations[0].draft)
      .toBe("Web restart draft");
    await page.reload();
    await expect(page.getByLabel("Message", { exact: true })).toHaveValue(
      "Web restart draft",
    );
    await expect(page.getByLabel("Active workspace")).toHaveValue(
      server.service.store.read().workspaces[0].id,
    );
    await page.screenshot({ path: "test-results/web-workspace.png" });
    await nav("Settings");
    let releasePreference!: () => void;
    const preferenceGate = new Promise<void>((resolve) => {
      releasePreference = resolve;
    });
    await page.route(
      "**/api/preferences",
      async (route) => {
        await preferenceGate;
        await route.continue();
      },
      { times: 1 },
    );
    try {
      await page.getByLabel("Compact interface").click();
      await expect(page.getByLabel("Compact interface")).toBeDisabled();
      // Current UI reflects committed preferences, not an optimistic write.
      await expect(page.getByLabel("Compact interface")).not.toBeChecked();
      await expect(page.locator(".app")).not.toHaveClass(/compact/);
      expect(server.service.store.read().preferences.compact).toBe(false);
    } finally {
      releasePreference();
    }
    await expect(page.getByLabel("Compact interface")).toBeEnabled();
    await expect(page.getByLabel("Compact interface")).toBeChecked();
    await expect(page.locator(".app")).toHaveClass(/compact/);
    expect(server.service.store.read().preferences.compact).toBe(true);
    await page.route(
      "**/api/preferences",
      (route) =>
        route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({
            ok: false,
            error: {
              code: "IO_ERROR",
              message: "Fixture preference write failure",
            },
          }),
        }),
      { times: 1 },
    );
    await page.getByLabel("Compact interface").click();
    await expect(page.locator(".notice.error")).toContainText(
      "Fixture preference write failure",
    );
    await expect(page.getByLabel("Compact interface")).toBeChecked();
    expect(server.service.store.read().preferences.compact).toBe(true);
    await page.getByLabel("Compact interface").click();
    await expect(page.getByLabel("Compact interface")).toBeEnabled();
    await expect(page.getByLabel("Compact interface")).not.toBeChecked();
    expect(server.service.store.read().preferences.compact).toBe(false);
    for (const size of [
      { width: 900, height: 640 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(size);
      for (const name of [
        "Workspace",
        "Agents",
        "Bots",
        "Browser",
        "Models & accounts",
        "Connectors",
        "Plugins & MCP",
        "Telemetry & backend",
        "Settings",
      ]) {
        await nav(name);
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
        expect(
          await page
            .locator(".content")
            .evaluate((e) => e.scrollWidth <= e.clientWidth + 1),
        ).toBe(true);
      }
      await expect(page.getByLabel("Compact interface")).toBeVisible();
    }
    await page.screenshot({ path: "test-results/web-mobile.png" });
    expect(errors).toEqual([]);
  } finally {
    await page.goto("about:blank");
    await server.close();
    await new Promise<void>((r) => fixture.close(() => r()));
    await fs.rm(dir, { recursive: true });
  }
});

test("Built web service starts from its delivery entrypoint and shuts down cleanly", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synora-web-cli-"));
  const child = spawn(process.execPath, ["out/web/server.mjs"], {
    cwd: process.cwd(),
    env: { ...process.env, SYNORA_WEB_DATA_DIR: dir, SYNORA_WEB_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (b) => (output += b.toString()));
  child.stderr.on("data", (b) => (output += b.toString()));
  const exit = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  try {
    await expect
      .poll(
        () =>
          output.match(/Synora local web: (http:\/\/127\.0\.0\.1:\d+)/)?.[1] ??
          "",
      )
      .toMatch(/^http:/);
    const url = output.match(
      /Synora local web: (http:\/\/127\.0\.0\.1:\d+)/,
    )![1];
    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Synora Harness Desktop");
    child.kill("SIGTERM");
    expect(await exit).toBe(0);
  } finally {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await exit;
    }
    await fs.rm(dir, { recursive: true });
  }
});
