import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { startWebService } from "../src/web/server";

test("OpenRouter browser UI: supported URL, paste-code grant, retry, cancellation, vault status and no false inference", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-router-login-web-"));
  let expectedChallenge = "",
    exchanges = 0,
    decline = true;
  const key = "SYNORA-CONTROLLED-BROWSER-KEY-NOT-PUBLIC";
  const server = await startWebService({
    storePath: join(directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
    openRouterExchange: async (code, verifier, signal) => {
      exchanges++;
      signal.throwIfAborted();
      expect(createHash("sha256").update(verifier).digest("base64url")).toBe(
        expectedChallenge,
      );
      expect(code).toBe("fixture-code");
      if (decline) throw Error("provider-private-error");
      return key;
    },
  });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  try {
    await page.goto(server.url);
    await page
      .getByRole("button", { name: "Models & accounts", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add configuration", exact: true })
      .click();
    await page.getByLabel("Configuration ID").fill("router-login");
    await page.getByLabel("Configuration name").fill("Owned browser provider");
    await page.getByLabel("Provider adapter").selectOption("openrouter");
    await page.getByLabel("Enable configuration").check();
    await page
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    const auth = page.getByRole("region", {
      name: "Browser sign-in for Owned browser provider",
      exact: true,
    });
    const vault = page.getByRole("region", {
      name: "Bearer token for Owned browser provider",
      exact: true,
    });
    const begin = async () => {
      await auth
        .getByRole("button", { name: "Sign in with browser", exact: true })
        .click();
      await expect(auth).toContainText("awaiting authorization");
      const url = new URL(
        (await auth
          .getByRole("link", { name: "Open OpenRouter authorization" })
          .getAttribute("href"))!,
      );
      expect(url.origin).toBe("https://openrouter.ai");
      expect(url.pathname).toBe("/auth");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.has("callback_url")).toBe(false);
      expectedChallenge = url.searchParams.get("code_challenge")!;
    };
    await expect(auth.getByLabel("Authorization return method")).toHaveValue(
      "paste-code",
    );
    await begin();
    const saved = server.service.store
      .read()
      .integrations.find((i) => i.id === "router-login")!;
    const rejected = await server.service.api.integrationSave(
      { ...saved, endpoint: "https://other.invalid" },
      saved.id,
    );
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).toContain("pending provider browser");
    await auth
      .getByRole("button", { name: "Cancel provider sign-in", exact: true })
      .click();
    await expect(auth).toContainText("Authorization: cancelled");
    expect(exchanges).toBe(0);
    await begin();
    await auth.getByLabel("Authorization code").fill("fixture-code");
    await auth
      .getByRole("button", { name: "Complete sign-in", exact: true })
      .click();
    await expect(auth).toContainText("Authorization: failed");
    await expect(auth).not.toContainText("provider-private-error");
    await expect(vault).toContainText("No token saved");
    decline = false;
    await begin();
    await auth.getByLabel("Authorization code").fill("fixture-code");
    await auth
      .getByRole("button", { name: "Complete sign-in", exact: true })
      .click();
    await expect(auth).toContainText("Authorization: authorized");
    await expect(vault).toContainText("Token saved for this endpoint");
    expect(exchanges).toBe(2);
    expect(JSON.stringify(server.service.store.read())).not.toContain(key);
    expect(
      JSON.stringify(await server.service.api.providerLoginStatus()),
    ).not.toContain(key);
    expect(server.service.store.read().engine.mode).toBe("simulated");
    await page.setViewportSize({ width: 390, height: 844 });
    await auth.scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await mkdir("out/live-evidence/openrouter-login-ui", { recursive: true });
    await page.screenshot({
      path: "out/live-evidence/openrouter-login-ui/authorized-390.png",
      fullPage: true,
    });
    const removed = await server.service.api.providerCredentialDelete(saved.id);
    expect(removed.ok).toBe(true);
    expect(errors).toEqual([]);
    await writeFile(
      "out/live-evidence/openrouter-login-web.json",
      JSON.stringify({
        passed: true,
        scope:
          "Real web UI and credential lifecycle; controlled grant, no public login/inference",
        exchanges,
        errors,
        engine: server.service.store.read().engine.mode,
      }),
    );
  } finally {
    await page.goto("about:blank");
    await server.close();
  }
});
