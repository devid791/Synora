import {
  test,
  expect,
  _electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { managedCore } from "../src/engine/core-runtime";
import { macosMetadataCore } from "./fixtures/macos-metadata-core";

test("Native IPC saves and cold-reads the original Core account, cancels browser login and signs out", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-native-account-"));
  const core = await managedCore(join(dir, "payload"));
  const wrapper =
    process.platform === "darwin"
      ? await macosMetadataCore(core, dir)
      : join(dir, "offline-core.sh");
  if (process.platform !== "darwin")
    await writeFile(
      wrapper,
      `#!/bin/sh\nexec /usr/bin/unshare --user --map-root-user --net -- '${core.replaceAll("'", "'\\''")}' "$@"\n`,
      { mode: 0o700 },
    );
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
        SYNORA_DATA_DIR: join(dir, "state"),
        SYNORA_CODEX_BINARY: wrapper,
      },
    });
    const page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Models & accounts", exact: true })
      .click();
    return page;
  };
  try {
    let page = await launch();
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
    await app!.close();
    app = undefined;
    page = await launch();
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
    // No actual browser consent/account grant. This native control calls the exact-ID cancel IPC.
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
      readFile(join(dir, "state/accounts/openai/auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(errors).toEqual([]);
    await page.screenshot({ path: "test-results/account-native/account.png" });
    await writeFile(
      `out/live-evidence/core-account-native-${process.platform}.json`,
      JSON.stringify(
        {
          passed: true,
          directory: dir,
          executable:
            process.env.SYNORA_TEST_EXECUTABLE ?? "development Electron",
          scope:
            "Original pinned Core with OS-enforced external-network denial; metadata/account only, no real account or inference",
          loginId: pending.ok ? pending.value.attempt?.loginId : null,
          coldRead: true,
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
