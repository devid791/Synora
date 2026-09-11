import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("Actual Windows packaged prerequisite check fails before inference, with setup choices and no OS changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-windows-prerequisite-")),
    workspace = join(dir, "workspace");
  await mkdir(workspace);
  const requests: { method?: string; url?: string }[] = [];
  // Forward only read-only catalog discovery. An unexpected model request is
  // recorded AND rejected locally; this negative gate cannot consume GPU work.
  const gate = createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    if (req.method !== "GET" || req.url !== "/codex/v1/models") {
      res.writeHead(500);
      res.end("Qualification forbids inference");
      return;
    }
    void fetch(`${process.env.SYNORA_TEST_ENDPOINT}/models`, {
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    })
      .then(async (r) => {
        res.writeHead(r.status, { "content-type": "application/json" });
        res.end(await r.text());
      })
      .catch(() => {
        res.writeHead(502);
        res.end("Read-only catalog unavailable");
      });
  });
  await new Promise<void>((r) => gate.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(gate.address() as { port: number }).port}/codex/v1`;
  let app: ElectronApplication | undefined;
  try {
    app = await _electron.launch({
      executablePath: process.env.SYNORA_TEST_EXECUTABLE,
      args: ["--disable-gpu"],
      chromiumSandbox: true,
      env: { ...process.env, SYNORA_DATA_DIR: join(dir, "state") },
    });
    const p = await app.firstWindow();
    const nav = (name: string) =>
      p.getByRole("button", { name, exact: true }).click();
    await app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, workspace);
    await nav("Add workspace");
    await nav("Models & accounts");
    await nav("Add configuration");
    await p.getByLabel("Configuration ID").fill("windows-prerequisite");
    await p
      .getByLabel("Configuration name")
      .fill("Read-only qualification gate");
    await p.getByLabel("Configuration endpoint").fill(endpoint);
    await p.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Settings");
    await p.getByLabel("Engine provider").selectOption("windows-prerequisite");
    await nav("Read live model catalog");
    await p.getByText("Native tool prerequisites", { exact: true }).click();
    await nav("Check native tool setup");
    // Fresh app-owned state first verifies/materializes the pinned Core archive.
    // Wait for that bounded operation, not a 10s text assertion during loading.
    await expect(
      p.getByRole("button", { name: "Check native tool setup" }),
    ).toBeEnabled({ timeout: 60000 });
    await expect(p.locator(".engine-settings [role=alert]")).toHaveCount(0);
    await expect(p.locator(".native-tool-setup")).toContainText(
      "Native setup: notConfigured",
    );
    await expect(
      p.getByRole("button", { name: "Set up administrator sandbox" }),
    ).toBeEnabled();
    await expect(
      p.getByRole("button", { name: "Set up restricted-token sandbox" }),
    ).toBeEnabled();
    await nav("Use live Axiom");
    await expect(
      p.getByRole("button", { name: "Set up administrator sandbox" }),
    ).toBeDisabled();
    await nav("Workspace");
    await p
      .getByLabel("Message", { exact: true })
      .fill(
        "This request must stop before inference because the native sandbox is not configured.",
      );
    await nav("Send message");
    await expect(p.locator("main")).toContainText("No model request was sent.");
    const snapshot = await p.evaluate(async () => {
      const r = await window.synora.engineSnapshot();
      if (!r.ok) throw new Error(r.error.message);
      return r.value;
    });
    expect(snapshot.status).toBe("failed");
    expect(snapshot.threadId).toBeNull();
    expect(snapshot.turnId).toBeNull();
    expect(snapshot.items).toEqual([]);
    expect(requests.length).toBeGreaterThan(0);
    expect(
      requests.every((r) => r.method === "GET" && r.url === "/codex/v1/models"),
    ).toBe(true);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/windows-prerequisite.json",
      JSON.stringify(
        { dir, snapshot, requests, inferenceRequests: 0, setupInvoked: false },
        null,
        2,
      ),
    );
    await p.screenshot({
      path: "test-results/windows-prerequisite/preinference-error.png",
    });
  } finally {
    await app?.close();
    gate.closeAllConnections();
    await new Promise<void>((r) => gate.close(() => r()));
  }
});
