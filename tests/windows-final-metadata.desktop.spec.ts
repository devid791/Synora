// Additive Windows versions of the existing native metadata/account/plugin
// workflows. Never substitute Linux/development results for package passes.
import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sha256File } from "../src/engine/core-runtime";
import {
  windowsFinalMetadataFixture,
  retainWindowsFinalMetadataReceipt,
  type WindowsFinalMetadataFixture,
} from "./fixtures/windows-final-metadata";

function harness(f: WindowsFinalMetadataFixture) {
  let app: ElectronApplication | undefined;
  let page: Page;
  const errors: string[] = [];
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const launch = async () => {
    app = await _electron.launch({
      executablePath: f.executable,
      args: ["--disable-gpu"],
      chromiumSandbox: true,
      cwd: f.qaRoot,
      env: {
        ...process.env,
        SYNORA_DATA_DIR: f.dataRoot,
        SYNORA_CODEX_BINARY: f.metadataExecutable,
      },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.isVisible()),
        ),
      )
      .toBe(true);
    return page;
  };
  const close = async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
  };
  const resize = async (zoom: number) => {
    await app!.evaluate(({ BrowserWindow }, z) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
      win.setContentSize(z === 1 ? 1440 : 1000, z === 1 ? 960 : 740);
      win.webContents.setZoomFactor(z);
    }, zoom);
  };
  const capture = async (name: string) => {
    await mkdir("test-results/windows-final-metadata", { recursive: true });
    const data = await app!.evaluate(async ({ BrowserWindow }) =>
      (
        await BrowserWindow.getAllWindows()
          .find((w) => w.isVisible())!
          .capturePage()
      ).toDataURL(),
    );
    await writeFile(
      `test-results/windows-final-metadata/${name}.png`,
      Buffer.from(data.slice(data.indexOf(",") + 1), "base64"),
    );
  };
  const pluginSetup = async () => {
    await app!.evaluate(({ dialog }, selected) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [selected],
      })) as typeof dialog.showOpenDialog;
    }, f.workspace);
    await nav("Add workspace");
    await nav("Models & accounts");
    await nav("Add configuration");
    await page.getByLabel("Configuration ID").fill("openai");
    await page.getByLabel("Configuration name").fill("Owned OpenAI");
    await page.getByLabel("Provider adapter").selectOption("openai");
    await page.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Plugins & MCP");
  };
  const noInference = async () => {
    const e = await page.evaluate(() => window.synora.engineSnapshot());
    expect(e.ok && e.value.items).toEqual([]);
    expect(
      await page.evaluate(() => typeof (window.synora as any).invoke),
    ).toBe("undefined");
    expect(errors).toEqual([]);
  };
  return {
    launch,
    close,
    nav,
    resize,
    capture,
    pluginSetup,
    noInference,
    errors,
    page: () => page,
  };
}

test("Windows final package: original offline account save/cold-read/browser-cancel/logout", async () => {
  test.setTimeout(45000);
  const f = await windowsFinalMetadataFixture(false),
    h = harness(f);
  try {
    let page = await h.launch();
    await h.nav("Models & accounts");
    let panel = page.getByRole("article", { name: "OpenAI account" });
    await panel.getByLabel("OpenAI sign-in method").selectOption("apiKey");
    await panel
      .getByLabel("OpenAI API key", { exact: true })
      .fill("sk-SYNORA-NATIVE-OFFLINE-DISPOSABLE-NOT-A-CREDENTIAL");
    await panel.getByRole("button", { name: "Save OpenAI API key" }).click();
    await expect(panel).toContainText("Core sign-in completed");
    await expect(panel).toContainText(
      "API key saved · inference access not verified",
    );
    await expect(
      panel.getByLabel("OpenAI API key", { exact: true }),
    ).toHaveValue("");
    expect(
      await page.evaluate(
        () => typeof (window.synora as any).coreAccountTokenRead,
      ),
    ).toBe("undefined");
    const first = await page.evaluate(() => window.synora.coreAccountStatus());
    expect(first.ok && first.value.account?.account?.type).toBe("apiKey");
    // Confirm the actual new Windows home, not a nonexistent POSIX-only path.
    const binding = JSON.parse(
      await readFile(
        join(f.dataRoot, "app-server", ".windows-home.json"),
        "utf8",
      ),
    );
    expect(binding.relative).toBe("app-server/windows-core");
    await h.close();
    page = await h.launch();
    await h.nav("Models & accounts");
    panel = page.getByRole("article", { name: "OpenAI account" });
    await expect(panel).toContainText("Account status not checked");
    await panel.getByRole("button", { name: "Refresh OpenAI account" }).click();
    await expect(panel).toContainText(
      "API key saved · inference access not verified",
    );
    await panel
      .getByRole("button", { name: "Sign out of Synora account" })
      .click();
    await expect(panel).toContainText("Not signed in");
    await panel.getByRole("button", { name: "Start OpenAI sign-in" }).click();
    await expect(
      panel.getByRole("button", { name: "Open OpenAI authorization page" }),
    ).toBeVisible();
    const pending = await page.evaluate(() =>
      window.synora.coreAccountStatus(),
    );
    expect(pending.ok && pending.value.attempt?.loginId).toBeTruthy();
    // Deliberately never click Open authorization page or supply a real grant.
    await panel.getByRole("button", { name: "Cancel OpenAI sign-in" }).click();
    await expect(panel).toContainText("ACCOUNT_CANCELLED");
    await expect(
      panel.getByRole("button", { name: "Open OpenAI authorization page" }),
    ).toHaveCount(0);
    await panel.getByRole("button", { name: "Refresh OpenAI account" }).click();
    await expect(panel).toContainText("Not signed in");
    await expect(
      panel.getByRole("button", { name: "Refresh OpenAI account" }),
    ).toBeEnabled();
    await expect(
      readFile(join(f.accountHome, "auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await h.noInference();
    await h.capture("account");
    await h.close();
    await retainWindowsFinalMetadataReceipt(f, "account", {
      loginId: pending.ok ? pending.value.attempt?.loginId : null,
      coldRead: true,
      browserOpened: false,
      accountHomeBinding: binding.relative,
      errors: h.errors,
    });
  } finally {
    await h.close();
  }
});

test("Windows final package: original local catalog/icons/cold metadata and native pixels", async () => {
  const f = await windowsFinalMetadataFixture(true),
    h = harness(f);
  try {
    let page = await h.launch();
    await h.pluginSetup();
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    let panel = page.getByRole("region", {
      name: "Original Core plugin catalog",
    });
    const read = async () => {
      await panel.getByLabel("Catalog provider").selectOption("openai");
      await panel.getByRole("button", { name: "Read Core catalog" }).click();
      await expect(
        panel.getByRole("heading", { name: "Synora Catalog Proof" }),
      ).toBeVisible();
      await expect(
        panel.getByRole("button", { name: "Read Core catalog" }),
      ).toBeEnabled();
    };
    await read();
    const first = await page.evaluate(() => window.synora.coreCatalogStatus());
    expect(
      first.ok && first.value?.plugins?.marketplaces[0].plugins[0].id,
    ).toBe("synora-catalog-proof@personal");
    expect(first.ok && first.value?.errors).toEqual([]);
    const firstIcon = panel.getByRole("img", {
      name: "Synora Catalog Proof original icon",
      exact: true,
    });
    await panel
      .getByRole("heading", { name: "Synora Catalog Proof" })
      .scrollIntoViewIfNeeded();
    await expect(firstIcon).toBeVisible();
    await expect(firstIcon).toHaveAttribute("data-icon-field", "logoDark");
    await expect(firstIcon).toHaveAttribute(
      "data-icon-sha256",
      await sha256File(join(f.plugin, "assets", "logo.svg")),
    );
    await expect
      .poll(() =>
        firstIcon.evaluate(
          (e: HTMLImageElement) => e.complete && e.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await h.close();
    page = await h.launch();
    await h.nav("Plugins & MCP");
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    panel = page.getByRole("region", { name: "Original Core plugin catalog" });
    const before = await page.evaluate(() => window.synora.coreCatalogStatus());
    expect(before.ok && before.value).toBeNull();
    await read();
    const second = await page.evaluate(() => window.synora.coreCatalogStatus());
    expect(second.ok && second.value?.id).not.toBe(first.ok && first.value?.id);
    expect(
      second.ok && second.value?.plugins?.marketplaces[0].plugins[0].id,
    ).toBe("synora-catalog-proof@personal");
    expect(second.ok && second.value?.errors).toEqual([]);
    for (const zoom of [1, 1.5]) {
      await h.resize(zoom);
      await panel.getByLabel("Catalog provider").scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await panel.getByLabel("Filter Core catalog").focus();
      await page.keyboard.type("proof");
      await expect(panel.getByRole("article")).toHaveCount(1);
      const icon = panel.getByRole("img", {
        name: "Synora Catalog Proof original icon",
        exact: true,
      });
      await panel
        .getByRole("heading", { name: "Synora Catalog Proof" })
        .scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          icon.evaluate(
            (e: HTMLImageElement) => e.complete && e.naturalWidth > 0,
          ),
        )
        .toBe(true);
      const ib = await icon.boundingBox(),
        hb = await panel
          .getByRole("heading", { name: "Synora Catalog Proof" })
          .boundingBox();
      expect(ib!.x + ib!.width).toBeLessThanOrEqual(hb!.x);
      await icon.scrollIntoViewIfNeeded();
      await h.capture(`icon-${zoom}`);
      await panel
        .getByText("Original plugin metadata", { exact: true })
        .focus();
      if ((await panel.locator("details").getAttribute("open")) === null)
        await page.keyboard.press("Enter");
      await expect(panel.locator("details pre")).toBeVisible();
      const box = await panel.locator("details pre").boundingBox(),
        bounds = await panel.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        bounds!.x + bounds!.width + 1,
      );
      await h.capture(`catalog-${zoom}`);
      await panel.getByLabel("Filter Core catalog").fill("");
    }
    await h.noInference();
    await h.close();
    await retainWindowsFinalMetadataReceipt(f, "catalog", {
      first,
      second,
      errors: h.errors,
      noInference: true,
    });
  } finally {
    await h.close();
  }
});

test("Windows final package: original local plugin review/install/cold-remove and modal focus", async () => {
  const f = await windowsFinalMetadataFixture(true),
    h = harness(f);
  try {
    let page = await h.launch();
    await h.pluginSetup();
    const read = async () => {
      await page.getByLabel("Catalog provider").selectOption("openai");
      await h.nav("Read Core catalog");
      await expect(
        page.getByRole("button", { name: "Inspect plugin capabilities" }),
      ).toBeEnabled();
      await h.nav("Inspect plugin capabilities");
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
    await h.resize(1.5);
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
    await h.capture("plugin-modal-150");
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
    expect(installed.ok && installed.value?.detail?.summary.installed).toBe(
      true,
    );
    await h.close();
    page = await h.launch();
    await h.nav("Plugins & MCP");
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
      await readFile(join(f.plugin, ".codex-plugin", "plugin.json"), "utf8"),
    ).toBe(JSON.stringify(f.manifest, null, 2));
    await h.noInference();
    await h.close();
    await retainWindowsFinalMetadataReceipt(f, "plugin", {
      installed,
      removed,
      errors: h.errors,
    });
  } finally {
    await h.close();
  }
});
