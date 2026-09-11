import { test, expect } from "@playwright/test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { startWebService } from "../src/web/server";
import { GoogleOAuthTransport, GOOGLE_SCOPE } from "../src/engine/google-oauth";
test("Google browser UI: own-client configuration, PKCE callback, cancellation, cold persistence and explicit local/revoke controls", async ({
  page,
}) => {
  const directory = await mkdtemp(join(tmpdir(), "synora-google-web-"));
  let expectedChallenge = "",
    exchanges = 0,
    revoked = 0,
    deny = true;
  const options = {
    storePath: join(directory, "state.sqlite"),
    assets: resolve("out/web/ui"),
    googleOAuthTransport: new GoogleOAuthTransport(async (url, options) => {
      const body = new URLSearchParams(String(options?.body));
      if (String(url).endsWith("revoke")) {
        revoked++;
        expect(body.get("token")).toBe("WEB_REFRESH_SECRET");
        return Response.json({});
      }
      exchanges++;
      expect(
        createHash("sha256")
          .update(body.get("code_verifier")!)
          .digest("base64url"),
      ).toBe(expectedChallenge);
      expect(body.get("client_secret")).toBe("WEB_CLIENT_SECRET");
      if (deny)
        return Response.json(
          { error: "access_denied", error_description: "WEB_CLIENT_SECRET" },
          { status: 400 },
        );
      return Response.json({
        access_token: "WEB_ACCESS_SECRET",
        refresh_token: "WEB_REFRESH_SECRET",
        token_type: "Bearer",
        scope: GOOGLE_SCOPE,
        expires_in: 3600,
      });
    }),
  };
  let server = await startWebService(options);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const panel = () =>
    page.getByRole("region", {
      name: "Google browser sign-in for Google login fixture",
      exact: true,
    });
  const begin = async () => {
    await panel()
      .getByRole("button", { name: "Sign in with Google", exact: true })
      .click();
    const link = panel().getByRole("link", {
      name: "Open Google authorization",
    });
    await expect(link).toBeVisible();
    const url = new URL((await link.getAttribute("href"))!);
    expectedChallenge = url.searchParams.get("code_challenge")!;
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("client_id")).toBe(
      "synora-web.apps.googleusercontent.com",
    );
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    callback.search = new URLSearchParams({
      state: url.searchParams.get("state")!,
      code: "fixture",
    }).toString();
    return callback;
  };
  const finish = async () => {
    const callback = await begin(),
      r = await fetch(callback);
    await r.text();
    return r.status;
  };
  try {
    await page.goto(server.url);
    await page
      .getByRole("button", { name: "Models & accounts", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Add configuration", exact: true })
      .click();
    await page.getByLabel("Configuration ID").fill("google-login");
    await page.getByLabel("Configuration name").fill("Google login fixture");
    await page.getByLabel("Provider adapter").selectOption("gemini");
    await page.getByLabel("Authentication method").selectOption("oauth");
    await page.getByLabel("Enable configuration").check();
    await page
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    await expect(
      panel().getByRole("button", { name: "Sign in with Google", exact: true }),
    ).toBeDisabled();
    await panel()
      .getByLabel("Google Desktop client ID")
      .fill("synora-web.apps.googleusercontent.com");
    await panel()
      .getByLabel("Google client secret", { exact: true })
      .fill("WEB_CLIENT_SECRET");
    await panel().getByLabel("Google quota project").fill("synora-fixture");
    await panel()
      .getByRole("button", { name: "Save Google OAuth client", exact: true })
      .click();
    await expect(panel()).toContainText("OAuth client configured");
    await expect(
      panel().getByLabel("Google client secret", { exact: true }),
    ).toHaveValue("");
    await begin();
    const p = server.service.store
      .read()
      .integrations.find((p) => p.id === "google-login")!;
    expect(
      (
        await server.service.api.integrationSave(
          { ...p, endpoint: "https://other.invalid" },
          p.id,
        )
      ).ok,
    ).toBe(false);
    await panel()
      .getByRole("button", { name: "Cancel Google sign-in", exact: true })
      .click();
    await expect(panel()).toContainText("Authorization: cancelled");
    expect(exchanges).toBe(0);
    expect(await finish()).toBe(400);
    await expect(panel()).toContainText("Authorization: failed");
    await expect(panel()).not.toContainText("WEB_CLIENT_SECRET");
    deny = false;
    expect(await finish()).toBe(200);
    await expect(panel()).toContainText("Google authorization saved");
    await expect(
      panel().getByRole("button", {
        name: "Save Google OAuth client",
        exact: true,
      }),
    ).toBeDisabled();
    await expect(
      panel().getByRole("button", {
        name: "Revoke Google access",
        exact: true,
      }),
    ).toBeDisabled();
    for (const secret of [
      "WEB_CLIENT_SECRET",
      "WEB_ACCESS_SECRET",
      "WEB_REFRESH_SECRET",
    ])
      expect(JSON.stringify(server.service.store.read())).not.toContain(secret);
    await page.goto("about:blank");
    await server.close();
    server = await startWebService(options);
    await page.goto(server.url);
    await page
      .getByRole("button", { name: "Models & accounts", exact: true })
      .click();
    await expect(panel()).toContainText("Google authorization saved");
    await page.setViewportSize({ width: 390, height: 844 });
    await panel()
      .getByRole("button", { name: "Disconnect Google locally", exact: true })
      .scrollIntoViewIfNeeded();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await mkdir("out/live-evidence/google-oauth-ui", { recursive: true });
    await page.screenshot({
      path: "out/live-evidence/google-oauth-ui/web-390.png",
      fullPage: true,
    });
    await panel()
      .getByRole("button", { name: "Disconnect Google locally", exact: true })
      .click();
    await expect(panel()).toContainText("sign-in required");
    expect(revoked).toBe(0);
    expect(await finish()).toBe(200);
    await expect(panel()).toContainText("Google authorization saved");
    await panel()
      .getByRole("checkbox", { name: /I understand revocation/ })
      .check();
    await panel()
      .getByRole("button", { name: "Revoke Google access", exact: true })
      .click();
    await expect(panel()).toContainText("sign-in required");
    expect(revoked).toBe(1);
    expect(await server.service.api.googleLoginStatus()).toEqual({
      ok: true,
      value: null,
    });
    await expect(panel()).not.toContainText("Authorization: authorized");
    await writeFile(
      join(directory, "google-oauth", "google-login.json"),
      "{broken owned QA credential",
    );
    await expect(panel().getByRole("alert")).toContainText("credential");
    await expect(
      panel().getByRole("button", {
        name: "Remove Google OAuth configuration",
        exact: true,
      }),
    ).toBeDisabled();
    await panel()
      .getByLabel("Confirm local Google configuration removal")
      .check();
    await panel()
      .getByRole("button", {
        name: "Remove Google OAuth configuration",
        exact: true,
      })
      .click();
    await expect(panel()).toContainText("OAuth client not configured");
    await expect(panel().getByRole("alert")).toHaveCount(0);
    expect(revoked).toBe(1);
    expect(errors).toEqual([]);
    await writeFile(
      "out/live-evidence/google-oauth-web.json",
      JSON.stringify({
        passed: true,
        scope:
          "Real web service/UI with controlled Google grants; no public login or model inference",
        exchanges,
        revoked,
        errors,
      }),
    );
  } finally {
    await page.goto("about:blank");
    await server.close();
  }
});
