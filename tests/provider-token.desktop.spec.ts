import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("Native IPC keeps Bearer credential across process restart without renderer retrieval or no-auth downgrade", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-native-bearer-"));
  const token = `fixture-${randomBytes(24).toString("hex")}`;
  const requests: { path: string; authorized: boolean }[] = [];
  const server = createServer((req, res) => {
    const authorized = req.headers.authorization === `Bearer ${token}`;
    requests.push({ path: req.url!, authorized });
    if (!authorized) {
      res.writeHead(401);
      return res.end("unauthorized");
    }
    res.end(
      JSON.stringify({
        data: [
          {
            id: "fixture-model",
            context_window: 262144,
            context_window_options: [262144],
            reasoning_efforts: ["ultra-fast"],
          },
        ],
        models: [{ slug: "fixture-model" }],
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/codex/v1`;
  let app: ElectronApplication | undefined;
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
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    return page;
  };
  try {
    let page = await launch();
    const saved = await page.evaluate(
      async (endpoint) =>
        window.synora.integrationSave({
          id: "external",
          name: "Native external Axiom",
          kind: "provider",
          enabled: true,
          auth: "api-key",
          tools: [],
          endpoint,
        }),
      endpoint,
    );
    expect(saved.ok).toBe(true);
    await page.reload();
    await page
      .getByRole("button", { name: "Models & accounts", exact: true })
      .click();
    await expect(page.getByRole("article", { name: "OpenAI account", exact: true }))
      .toContainText("Account checked", { timeout: 20000 });
    let panel = page.getByRole("region", {
      name: "Bearer token for Native external Axiom",
    });
    await panel
      .getByLabel("Bearer token for Native external Axiom")
      .fill(token);
    await panel
      .getByRole("button", { name: "Save token", exact: true })
      .click();
    await expect(panel).toContainText("Token saved for this endpoint");
    const storage = await page.evaluate(() =>
      window.synora.providerCredentialStatus("external"),
    );
    expect(storage.ok && storage.value.usable).toBe(true);
    expect(JSON.stringify(storage)).not.toContain(token);
    const safeStorage = await app!.evaluate(({ safeStorage }) => ({
      available: safeStorage.isEncryptionAvailable(),
      backend:
        process.platform === "linux"
          ? safeStorage.getSelectedStorageBackend()
          : "native",
    }));
    await panel.getByRole("button", { name: "Verify access" }).click();
    await expect(panel).toContainText(
      "Authenticated model catalog received: 1",
    );
    await app!.close();
    app = undefined;
    page = await launch();
    await expect(page.getByRole("article", { name: "OpenAI account", exact: true }))
      .toContainText("Account checked", { timeout: 20000 });
    panel = page.getByRole("region", {
      name: "Bearer token for Native external Axiom",
    });
    await expect(panel).toContainText("Token saved for this endpoint");
    await expect(
      panel.getByLabel("Bearer token for Native external Axiom"),
    ).toHaveValue("");
    expect(
      await page.evaluate(
        () => typeof (window.synora as any).providerCredentialRead,
      ),
    ).toBe("undefined");
    await panel.getByRole("button", { name: "Verify access" }).click();
    await expect(panel).toContainText(
      "Authenticated model catalog received: 1",
    );
    await page.screenshot({
      path: "test-results/provider-native/actual-token-settings.png",
    });
    await panel.getByRole("button", { name: "Remove token" }).click();
    await expect(panel).toContainText("No token saved");
    expect(requests.length).toBe(2);
    expect(
      requests.every((v) => v.authorized && v.path === "/codex/v1/models"),
    ).toBe(true);
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      `out/live-evidence/provider-bearer-native-${process.platform}.json`,
      JSON.stringify(
        {
          passed: true,
          dir,
          platform: process.platform,
          executable:
            process.env.SYNORA_TEST_EXECUTABLE ?? "development Electron",
          storage,
          safeStorage,
          requests,
          inferenceRequests: 0,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await app?.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
