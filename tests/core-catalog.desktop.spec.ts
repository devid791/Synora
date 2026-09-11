import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ownedCatalogFixture } from "./fixtures/core-catalog";
import { sha256File } from "../src/engine/core-runtime";
test("Native catalog IPC: original Core plugin, exact identity, cold read, scoped metadata and 150% layout", async () => {
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
    await page
      .getByRole("button", { name: "Add workspace", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Models & accounts", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add configuration", exact: true })
      .click();
    await page.getByLabel("Configuration ID").fill("openai");
    await page.getByLabel("Configuration name").fill("Owned OpenAI");
    await page.getByLabel("Provider adapter").selectOption("openai");
    await page.getByLabel("Enable configuration").check();
    await page
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Plugins & MCP", exact: true })
      .click();
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    let panel = page.getByRole("region", {
      name: "Original Core plugin catalog",
    });
    await panel.getByLabel("Catalog provider").selectOption("openai");
    await panel.getByRole("button", { name: "Read Core catalog" }).click();
    await expect(
      panel.getByRole("heading", { name: "Synora Catalog Proof" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Read Core catalog" }),
    ).toBeEnabled();
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
      await sha256File(join(fixture.plugin, "assets/logo.svg")),
    );
    await expect
      .poll(() =>
        firstIcon.evaluate(
          (e: HTMLImageElement) => e.complete && e.naturalWidth > 0,
        ),
      )
      .toBe(true);
    await app!.close();
    app = undefined;
    page = await launch();
    await page.getByText("Manage installed plugins and account catalogs", { exact: true }).click();
    panel = page.getByRole("region", { name: "Original Core plugin catalog" });
    const before = await page.evaluate(() => window.synora.coreCatalogStatus());
    expect(before.ok && before.value).toBeNull();
    await panel.getByLabel("Catalog provider").selectOption("openai");
    await panel.getByRole("button", { name: "Read Core catalog" }).click();
    await expect(
      panel.getByRole("heading", { name: "Synora Catalog Proof" }),
    ).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Read Core catalog" }),
    ).toBeEnabled();
    const second = await page.evaluate(() => window.synora.coreCatalogStatus());
    expect(second.ok && second.value?.id).not.toBe(first.ok && first.value?.id);
    expect(
      second.ok && second.value?.plugins?.marketplaces[0].plugins[0].id,
    ).toBe("synora-catalog-proof@personal");
    const noGeneric = await page.evaluate(
      () => typeof (window.synora as any).invoke,
    );
    expect(noGeneric).toBe("undefined");
    for (const zoom of [1, 1.5]) {
      await app!.evaluate(({ BrowserWindow }, factor) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
        win.setContentSize(
          factor === 1 ? 1440 : 1000,
          factor === 1 ? 960 : 740,
        );
        win.webContents.setZoomFactor(factor);
      }, zoom);
      await panel.getByLabel("Catalog provider").scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await panel.getByLabel("Filter Core catalog").focus();
      await page.keyboard.type("proof");
      await expect(panel.getByRole("article")).toHaveCount(1);
      const currentIcon = panel.getByRole("img", {
        name: "Synora Catalog Proof original icon",
        exact: true,
      });
      await panel
        .getByRole("heading", { name: "Synora Catalog Proof" })
        .scrollIntoViewIfNeeded();
      await expect
        .poll(() =>
          currentIcon.evaluate(
            (e: HTMLImageElement) => e.complete && e.naturalWidth > 0,
          ),
        )
        .toBe(true);
      const ib = await currentIcon.boundingBox(),
        hb = await panel
          .getByRole("heading", { name: "Synora Catalog Proof" })
          .boundingBox();
      expect(ib!.x + ib!.width).toBeLessThanOrEqual(hb!.x);
      await currentIcon.scrollIntoViewIfNeeded();
      const iconCapture = await app!.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
        return (await win.capturePage()).toDataURL();
      });
      await writeFile(
        `test-results/core-catalog-native/icon-${zoom}.png`,
        Buffer.from(iconCapture.slice(iconCapture.indexOf(",") + 1), "base64"),
      );
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
      // CDP crops native Electron captures at non-unit zoom. Use original
      // BrowserWindow pixels, as the established native quality checks do.
      const image = await app!.evaluate(async ({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows().find((w) => w.isVisible())!;
        return (await win.capturePage()).toDataURL();
      });
      await writeFile(
        `test-results/core-catalog-native/catalog-${zoom}.png`,
        Buffer.from(image.slice(image.indexOf(",") + 1), "base64"),
      );
      await panel.getByLabel("Filter Core catalog").fill("");
    }
    expect(errors).toEqual([]);
    const engine = await page.evaluate(() => window.synora.engineSnapshot());
    expect(engine.ok && engine.value.items).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/core-catalog-native-linux.json",
      JSON.stringify(
        {
          passed: true,
          at: new Date().toISOString(),
          fixture,
          coreSha256: await sha256File(fixture.core),
          first,
          second,
          errors,
          noInference: true,
          platform: process.platform,
          executable: process.env.SYNORA_TEST_EXECUTABLE ?? "development Electron",
          asarSha256: test.info().config.metadata.asar_sha256,
          scope:
            "Actual native IPC/original Core metadata on the identified executable; local QA catalog, no inference, public account or plugin execution",
        },
        null,
        2,
      ),
    );
  } finally {
    await app?.close();
  }
});
