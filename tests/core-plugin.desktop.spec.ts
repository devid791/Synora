import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ownedCatalogFixture } from "./fixtures/core-catalog";
import { sha256File } from "../src/engine/core-runtime";
test("Native original plugin install, cold restart/removal, exact IPC and 150% modal layout", async () => {
  const fixture = await ownedCatalogFixture(undefined, undefined, true);
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
      env: {
        ...process.env,
        SYNORA_DATA_DIR: join(fixture.directory, "state"),
        SYNORA_CODEX_BINARY: fixture.metadataExecutable,
      },
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
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selected],
      })) as typeof dialog.showOpenDialog;
    }, fixture.workspace);
    const nav = (name: string) =>
      page.getByRole("button", { name, exact: true }).click();
    await nav("Add workspace");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("openai");
    await page.getByLabel("Configuration name").fill("Owned OpenAI");
    await page.getByLabel("Provider adapter").selectOption("openai");
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Plugins & MCP");
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    const read = async () => {
      await page.getByLabel("Catalog provider").selectOption("openai");
      await nav("Read Core catalog");
      await expect(
        page.getByRole("button", { name: "Inspect plugin capabilities" }),
      ).toBeEnabled();
      await nav("Inspect plugin capabilities");
      await expect(
        page
          .getByRole("dialog", { name: "Core plugin management" })
          .getByRole("status"),
      ).toContainText("Original plugin details loaded.");
    };
    await read();
    let dialog = page.getByRole("dialog", { name: "Core plugin management" });
    await expect(
      dialog.getByRole("button", { name: "Install plugin", exact: true }),
    ).toBeDisabled();
    await app!.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
      w.setContentSize(1000, 740);
      w.webContents.setZoomFactor(1.5);
    });
    await dialog.getByRole("checkbox").scrollIntoViewIfNeeded();
    await dialog.getByRole("checkbox").focus();
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(
          () => !!document.activeElement?.closest("dialog[open]"),
        ),
      ).toBe(true);
    }
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await dialog.getByRole("checkbox").scrollIntoViewIfNeeded();
    const image = await app!.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()
          .find((w) => w.isVisible())!
          .capturePage()
      ).toDataURL(),
    );
    await writeFile(
      "test-results/core-plugin-native/modal-150.png",
      Buffer.from(image.slice(image.indexOf(",") + 1), "base64"),
    );
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Install plugin", exact: true })
      .click();
    await expect(dialog).toContainText(
      "Plugin installed and enabled; state verified by Core.",
    );
    const installed = await page.evaluate(() =>
      window.synora.corePluginStatus(),
    );
    await app!.close();
    app = undefined;
    page = await launch();
    await read();
    dialog = page.getByRole("dialog", { name: "Core plugin management" });
    await expect(dialog).toContainText("Installed · Enabled · AVAILABLE");
    await dialog.getByRole("checkbox").check();
    await dialog
      .getByRole("button", { name: "Remove plugin", exact: true })
      .click();
    await expect(dialog).toContainText(
      "Plugin removed from this Synora profile; state verified by Core.",
    );
    const removed = await page.evaluate(() => window.synora.corePluginStatus());
    expect(removed.ok && removed.value?.detail?.summary.installed).toBe(false);
    expect(
      await readFile(join(fixture.plugin, ".codex-plugin/plugin.json"), "utf8"),
    ).toBe(JSON.stringify(fixture.manifest, null, 2));
    expect(
      await page.evaluate(() => typeof (window.synora as any).invoke),
    ).toBe("undefined");
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/core-plugin-native-linux.json",
      JSON.stringify(
        {
          passed: true,
          at: new Date().toISOString(),
          fixture,
          coreSha256: await sha256File(fixture.core),
          installed,
          removed,
          errors,
          platform: process.platform,
          executable: process.env.SYNORA_TEST_EXECUTABLE ?? "development Electron",
          asarSha256: test.info().config.metadata.asar_sha256,
          scope:
            "Native IPC/original Core local QA plugin install, cold restart and remove on the identified executable; no inference or public account",
        },
        null,
        2,
      ),
    );
  } finally {
    await app?.close();
  }
});
