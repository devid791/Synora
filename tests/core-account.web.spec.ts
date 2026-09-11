import { test, expect } from "@playwright/test";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { startWebService } from "../src/web/server";
import { managedCore } from "../src/engine/core-runtime";

test("Shared UI owns original Core account save, cold read, browser cancel and logout without external network", async ({
  page,
}) => {
  const dir = await mkdtemp(join(tmpdir(), "synora-account-ui-"));
  const executable = await managedCore(join(dir, "payload"));
  // Every Core process has a separate network namespace with no external NIC.
  // This wrapper is a test artifact, never included in a runtime package.
  const wrapper = join(dir, "offline-core.sh");
  const quoted = "'" + executable.replaceAll("'", "'\\''") + "'";
  await writeFile(
    wrapper,
    `#!/bin/sh\nexec /usr/bin/unshare --user --map-root-user --net -- ${quoted} "$@"\n`,
    { mode: 0o700 },
  );
  const oldBinary = process.env.SYNORA_CODEX_BINARY;
  process.env.SYNORA_CODEX_BINARY = wrapper;
  const options = {
    storePath: join(dir, "state.sqlite"),
    assets: resolve("out/web/ui"),
  };
  let server = await startWebService(options);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const panel = page.getByRole("article", { name: "OpenAI account" });
  const button = (name: string) =>
    panel.getByRole("button", { name, exact: true });
  const fixtureKey = "sk-SYNORA-UI-OFFLINE-DISPOSABLE-NOT-A-CREDENTIAL";
  try {
    await page.goto(server.url);
    await page
      .getByRole("button", { name: "Models & accounts", exact: true })
      .click();
    await expect(panel).toContainText("Account status not checked");
    await button("Refresh OpenAI account").click();
    await expect(panel).toContainText("Not signed in");
    await panel.getByLabel("OpenAI sign-in method").selectOption("apiKey");
    const input = panel.getByLabel("OpenAI API key", { exact: true });
    await expect(input).toHaveAttribute("type", "password");
    await input.fill("not a valid key");
    await button("Save OpenAI API key").click();
    await expect(panel.getByRole("alert")).toBeVisible();
    await expect(input).toHaveValue("");
    await input.fill(fixtureKey);
    await button("Save OpenAI API key").click();
    await expect(panel).toContainText("Core sign-in completed");
    await expect(panel).toContainText(
      "API key saved · inference access not verified",
    );
    await expect(input).toHaveValue("");
    await expect(panel.getByRole("alert")).toHaveCount(0);
    expect(JSON.stringify(server.service.store.read())).not.toContain(
      fixtureKey,
    );
    const snapshot = await server.service.api.coreAccountStatus();
    expect(snapshot.ok && snapshot.value.account?.account?.type).toBe("apiKey");
    expect(JSON.stringify(snapshot)).not.toContain(fixtureKey);
    expect(
      (await stat(join(dir, "accounts/openai/auth.json"))).mode & 0o777,
    ).toBe(0o600);
    expect((await server.service.invoke("coreAccountTokenRead", [])).ok).toBe(
      false,
    );
    await page.goto("about:blank");
    await server.close();
    server = await startWebService(options);
    await page.goto(server.url);
    await expect(panel).toContainText("Account status not checked");
    await button("Refresh OpenAI account").click();
    await expect(panel).toContainText(
      "API key saved · inference access not verified",
    );
    await button("Sign out of Synora account").click();
    await expect(panel).toContainText("Not signed in");
    await expect
      .poll(async () =>
        server.service.api
          .coreAccountStatus()
          .then((r) => r.ok && r.value.busy),
      )
      .toBe(false);
    await expect(
      readFile(join(dir, "accounts/openai/auth.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await panel.getByLabel("OpenAI sign-in method").selectOption("chatgpt");
    await button("Start OpenAI sign-in").click();
    const link = panel.getByRole("link", {
      name: "Open OpenAI authorization page",
    });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
    await expect(link).toHaveAttribute("target", "_blank");
    expect(new URL((await link.getAttribute("href"))!).origin).toBe(
      "https://auth.openai.com",
    );
    await expect(button("Refresh OpenAI account")).toBeDisabled();
    const pending = await server.service.api.coreAccountStatus();
    if (!pending.ok || !pending.value.attempt)
      throw new Error("No original account attempt");
    const { id, loginId } = pending.value.attempt;
    expect(loginId).toBeTruthy();
    const mutation = await server.service.api.engineConfigure({
      mode: "simulated",
      providerId: null,
      model: null,
    });
    expect(mutation.ok).toBe(false);
    if (!mutation.ok)
      expect(mutation.error.message).toContain("pending account operation");
    await page.reload();
    await expect(link).toBeVisible();
    const resumed = await server.service.api.coreAccountStatus();
    expect(resumed.ok && resumed.value.attempt?.id).toBe(id);
    expect(resumed.ok && resumed.value.attempt?.loginId).toBe(loginId);
    await button("Cancel OpenAI sign-in").click();
    await expect(panel).toContainText("ACCOUNT_CANCELLED");
    await expect(link).toHaveCount(0);
    await button("Refresh OpenAI account").click();
    await expect(panel).toContainText("Not signed in");
    await expect(button("Refresh OpenAI account")).toBeEnabled();
    await panel.getByLabel("OpenAI sign-in method").selectOption("apiKey");
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await input.scrollIntoViewIfNeeded();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const box = await input.boundingBox(),
        bounds = await panel.boundingBox();
      expect(box).toBeTruthy();
      expect(bounds).toBeTruthy();
      expect(box!.x).toBeGreaterThanOrEqual(bounds!.x);
      expect(box!.x + box!.width).toBeLessThanOrEqual(
        bounds!.x + bounds!.width,
      );
      await input.focus();
      await expect(input).toBeFocused();
      await page.screenshot({
        path: `test-results/account-web/account-${width}.png`,
        fullPage: true,
      });
    }
    expect(errors).toEqual([]);
    expect(server.service.store.read().engine.mode).toBe("simulated");
    expect(server.service.engine.snapshot().items).toEqual([]);
    await writeFile(
      "out/live-evidence/core-account-web.json",
      JSON.stringify(
        {
          passed: true,
          directory: dir,
          engine: "Original pinned Core, OS-network-isolated",
          originalLoginId: loginId,
          attemptId: id,
          coldAccountRead: true,
          browserOpened: false,
          inference: false,
          externalAccount: false,
          errors,
        },
        null,
        2,
      ),
    );
  } finally {
    await page.goto("about:blank");
    await server.close();
    if (oldBinary === undefined) delete process.env.SYNORA_CODEX_BINARY;
    else process.env.SYNORA_CODEX_BINARY = oldBinary;
  }
});
