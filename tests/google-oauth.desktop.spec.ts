import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, stat } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { GOOGLE_SCOPE } from "../src/engine/google-oauth";
import { sha256File } from "../src/engine/core-runtime";
test("Google native Linux: original main/preload/UI, external browser URL, actual callback grant, cold credential restore, 150% layout and logout", async ({}, testInfo) => {
  expect(process.platform).toBe("linux");
  const executable = process.env.SYNORA_TEST_EXECUTABLE;
  const run = process.env.SYNORA_QA_GOOGLE_RUN_DIR;
  const helper = resolve("tests/fixtures/google-packaged-peer.cjs");
  const asar = executable
    ? join(dirname(executable), "resources/app.asar")
    : undefined;
  const before =
    asar && executable
      ? {
          asar: await sha256File(asar),
          executable: await sha256File(executable),
        }
      : undefined;
  if (executable) {
    expect(run).toBeTruthy();
    expect(before!.asar).toBe(process.env.SYNORA_QA_EXPECT_ASAR);
    // Prove the actual inherited network namespace, not an environment flag.
    expect(Object.keys(networkInterfaces()).sort()).toEqual(["lo"]);
  }
  const directory = await mkdtemp(join(tmpdir(), "synora-google-native-"));
  let challenge = "",
    redirect = "",
    grants = 0,
    revokes = 0;
  const attempts: { challenge: string; state: string; redirect: string }[] = [];
  const packageLaunches: any[] = [],
    packageClosures: any[] = [];
  const appPids: number[] = [];
  const cleanupErrors: string[] = [];
  let status: unknown,
    coldStatus: unknown,
    failure: unknown,
    completed = false;
  const paths = {
    pixels: run
      ? join(run, "google-oauth-ui", "linux-150.png")
      : "out/live-evidence/google-oauth-ui/linux-150.png",
    receipt: run
      ? join(run, "evidence.json")
      : "out/live-evidence/google-oauth-native.json",
  };
  const errors: string[] = [],
    providerErrors: string[] = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks: Buffer[] = [];
      for await (const b of req) chunks.push(b);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      expect(req.method).toBe("POST");
      if (req.url === "/revoke") {
        revokes++;
        expect(body.get("token")).toBe("NATIVE_REFRESH_SECRET");
        res.end("{}");
        return;
      }
      expect(req.url).toBe("/token");
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe(
        "native-synora.apps.googleusercontent.com",
      );
      expect(body.get("client_secret")).toBe("NATIVE_CLIENT_SECRET");
      expect(body.get("code")).toBe("native-code");
      expect(body.get("redirect_uri")).toBe(redirect);
      expect(req.headers["content-type"]).toBe(
        "application/x-www-form-urlencoded",
      );
      expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(
        createHash("sha256")
          .update(body.get("code_verifier")!)
          .digest("base64url"),
      ).toBe(challenge);
      grants++;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          access_token: "NATIVE_ACCESS_SECRET",
          refresh_token: "NATIVE_REFRESH_SECRET",
          scope: GOOGLE_SCOPE,
          token_type: "Bearer",
          expires_in: 3600,
        }),
      );
    } catch (e) {
      providerErrors.push(String(e));
      res.writeHead(500);
      res.end("Controlled authorization failed");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const sourceMain = executable
      ? undefined
      : await sha256File(resolve("dist/main.cjs")),
    sourcePreload = executable
      ? undefined
      : await sha256File(resolve("dist/preload.cjs"));
  let app: ElectronApplication | undefined, page!: Page;
  let peerInstalled = false;
  const close = async () => {
    if (!app) return;
    if (executable && peerInstalled) {
      packageClosures.push(
        await app.evaluate(
          (_electron, file) =>
            process
              .getBuiltinModule("module")
              .createRequire(file)(file)
              .restore(),
          helper,
        ),
      );
      peerInstalled = false;
    }
    const child = app.process();
    await app.close();
    app = undefined;
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  };
  const launch = async () => {
    app = await _electron.launch({
      executablePath: executable,
      args: executable
        ? ["--disable-gpu"]
        : ["tests/fixtures/google-native-bootstrap.cjs", "--disable-gpu"],
      cwd: process.cwd(),
      chromiumSandbox: true,
      env: {
        ...process.env,
        SYNORA_DATA_DIR: directory,
        SYNORA_QA_GOOGLE_ENDPOINT: `http://127.0.0.1:${(server.address() as any).port}`,
      },
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Models & accounts", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        app!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(true);
    appPids.push(app.process().pid!);
    if (executable) {
      const identity = await app.evaluate(
        (_electron, options) =>
          process
            .getBuiltinModule("module")
            .createRequire(options.helper)(options.helper)
            .install(options),
        {
          helper,
          endpoint: `http://127.0.0.1:${(server.address() as any).port}`,
          directory,
          executable,
          asarSha256: before!.asar,
        },
      );
      peerInstalled = true;
      expect(identity.fetchUnchanged).toBe(true);
      expect(identity.dispatcherInstalled).toBe(true);
      expect(identity.requests).toEqual([]);
      packageLaunches.push(identity);
    }
    await page
      .getByRole("button", { name: "Models & accounts", exact: true })
      .click();
  };
  const panel = () =>
    page.getByRole("region", {
      name: "Google browser sign-in for Native Google",
      exact: true,
    });
  const authorize = async () => {
    await panel()
      .getByRole("button", { name: "Sign in with Google", exact: true })
      .click();
    await expect(
      panel().getByRole("link", { name: "Open Google authorization" }),
    ).toBeVisible();
    const url = new URL(
      (await panel()
        .getByRole("link", { name: "Open Google authorization" })
        .getAttribute("href"))!,
    );
    const opened = executable
      ? await app!.evaluate(
          (_electron, file) =>
            process
              .getBuiltinModule("module")
              .createRequire(file)(file)
              .snapshot()
              .opened.at(-1),
          helper,
        )
      : await app!.evaluate(
          () => (globalThis as any).synoraQaGoogleAuthorization,
        );
    expect(opened).toBe(url.href);
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("client_id")).toBe(
      "native-synora.apps.googleusercontent.com",
    );
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_SCOPE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.href).not.toContain("SECRET");
    challenge = url.searchParams.get("code_challenge")!;
    redirect = url.searchParams.get("redirect_uri")!;
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("state")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(attempts.map((a) => a.challenge)).not.toContain(challenge);
    expect(attempts.map((a) => a.state)).not.toContain(
      url.searchParams.get("state"),
    );
    attempts.push({
      challenge,
      state: url.searchParams.get("state")!,
      redirect,
    });
    const callback = new URL(url.searchParams.get("redirect_uri")!);
    expect(callback.protocol).toBe("http:");
    expect(callback.hostname).toBe("127.0.0.1");
    expect(callback.port).not.toBe("");
    expect(callback.pathname).toBe("/");
    const invalid = new URL(callback);
    invalid.search = new URLSearchParams({
      code: "native-code",
      state: "wrong-state",
    }).toString();
    const refused = await fetch(invalid, { signal: AbortSignal.timeout(5000) });
    expect(refused.status).toBe(400);
    await refused.text();
    expect(grants).toBe(attempts.length - 1);
    callback.search = new URLSearchParams({
      code: "native-code",
      state: url.searchParams.get("state")!,
    }).toString();
    const response = await fetch(callback, {
      signal: AbortSignal.timeout(5000),
    });
    expect(response.status).toBe(200);
    await response.text();
    await expect(panel()).toContainText("Google authorization saved");
    // A terminal callback must no longer listen or admit a replay.
    await expect
      .poll(async () => {
        try {
          await fetch(callback, { signal: AbortSignal.timeout(1000) });
          return false;
        } catch (e) {
          return (e as any).cause?.code === "ECONNREFUSED";
        }
      })
      .toBe(true);
    expect(grants).toBe(attempts.length);
  };
  try {
    await launch();
    await page
      .getByRole("button", { name: "Add configuration", exact: true })
      .click();
    await page.getByLabel("Configuration ID").fill("native-google");
    await page.getByLabel("Configuration name").fill("Native Google");
    await page.getByLabel("Provider adapter").selectOption("gemini");
    await page.getByLabel("Authentication method").selectOption("oauth");
    await page.getByLabel("Enable configuration").check();
    await page
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    await panel()
      .getByLabel("Google Desktop client ID")
      .fill("native-synora.apps.googleusercontent.com");
    await panel().getByLabel("Google quota project").fill("synora-fixture");
    await panel()
      .getByLabel("Google client secret", { exact: true })
      .fill("NATIVE_CLIENT_SECRET");
    await panel()
      .getByRole("button", { name: "Save Google OAuth client", exact: true })
      .click();
    await expect(panel()).toContainText("OAuth client configured");
    await authorize();
    const firstStatus = await page.evaluate(() =>
      window.synora.googleAccountStatus("native-google"),
    );
    status = firstStatus;
    expect(firstStatus.ok && firstStatus.value.authorized).toBe(true);
    expect(JSON.stringify(firstStatus)).not.toContain("SECRET");
    await close();
    await launch();
    await expect(panel()).toContainText("Google authorization saved");
    coldStatus = await page.evaluate(() =>
      window.synora.googleAccountStatus("native-google"),
    );
    expect(coldStatus).toEqual(status);
    await app!.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5),
    );
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await panel()
      .getByRole("button", { name: "Disconnect Google locally", exact: true })
      .scrollIntoViewIfNeeded();
    await expect(
      panel().getByRole("button", {
        name: "Disconnect Google locally",
        exact: true,
      }),
    ).toBeInViewport();
    await page.waitForTimeout(150); // native compositor paint after zoom/scroll, not a readiness substitute
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await expect(
      panel().getByRole("button", {
        name: "Revoke Google access",
        exact: true,
      }),
    ).toBeDisabled();
    await mkdir(dirname(paths.pixels), { recursive: true });
    const png = await app!.evaluate(async ({ BrowserWindow }) =>
      (await BrowserWindow.getAllWindows()[0].capturePage())
        .toPNG()
        .toString("base64"),
    );
    await writeFile(paths.pixels, Buffer.from(png, "base64"));
    await panel()
      .getByRole("button", { name: "Disconnect Google locally", exact: true })
      .click();
    await expect(panel()).toContainText("sign-in required");
    expect(revokes).toBe(0);
    await authorize();
    await panel()
      .getByRole("checkbox", { name: /I understand revocation/ })
      .check();
    await panel()
      .getByRole("button", { name: "Revoke Google access", exact: true })
      .click();
    await expect(panel()).toContainText("sign-in required");
    expect(revokes).toBe(1);
    expect(grants).toBe(2);
    expect(errors).toEqual([]);
    expect(providerErrors).toEqual([]);
    if (!executable) {
      expect(await sha256File(resolve("dist/main.cjs"))).toBe(sourceMain);
      expect(await sha256File(resolve("dist/preload.cjs"))).toBe(sourcePreload);
    }
    completed = true;
  } catch (e) {
    failure = e;
    throw e;
  } finally {
    if (failure && app && run) {
      try {
        const png = await app.evaluate(async ({ BrowserWindow }) =>
          (await BrowserWindow.getAllWindows()[0].capturePage())
            .toPNG()
            .toString("base64"),
        );
        await writeFile(
          join(run, "failure-original.png"),
          Buffer.from(png, "base64"),
        );
      } catch (e) {
        cleanupErrors.push(`Failure capture: ${String(e)}`);
      }
    }
    try {
      await close();
    } catch (e) {
      cleanupErrors.push(`App cleanup: ${String(e)}`);
      await app?.close().catch((error) => cleanupErrors.push(String(error)));
    }
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
    const after =
      asar && executable
        ? {
            asar: await sha256File(asar),
            executable: await sha256File(executable),
          }
        : undefined;
    const alive = appPids.filter((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (e) {
        return (e as NodeJS.ErrnoException).code !== "ESRCH";
      }
    });
    if (JSON.stringify(before) !== JSON.stringify(after))
      cleanupErrors.push("Package hash changed");
    if (alive.length)
      cleanupErrors.push(`Owned app PIDs remain: ${alive.join(",")}`);
    if (executable && completed) {
      const requests = packageClosures.flatMap((entry) => entry.requests);
      if (
        JSON.stringify(requests.map((request) => request.path)) !==
        JSON.stringify(["/token", "/token", "/revoke"])
      )
        cleanupErrors.push("Unexpected dispatcher HTTP transcript");
      if (
        packageClosures.length !== 2 ||
        !packageClosures.every(
          (entry) =>
            entry.restored &&
            entry.fetchUnchanged &&
            !entry.dispatcherInstalled,
        )
      )
        cleanupErrors.push("QA dispatcher restoration not verified");
    }
    await mkdir(dirname(paths.receipt), { recursive: true });
    await writeFile(
      paths.receipt,
      JSON.stringify(
        {
          passed: completed && !failure && !cleanupErrors.length,
          scope: executable
            ? "Actual packaged main/preload/IPC/UI/storage; controlled Google HTTP peer/browser, NOT public authorization/inference"
            : "Original development main/preload/shared UI; QA bootstrap controls OAuth peer/browser, NOT packaged or public consent/inference",
          metadata: testInfo.config.metadata,
          directory,
          before,
          after,
          sourceMain: sourceMain ?? packageLaunches[0]?.mainSha256,
          sourcePreload: sourcePreload ?? packageLaunches[0]?.preloadSha256,
          grants,
          revokes,
          status,
          coldStatus,
          attempts,
          errors,
          providerErrors,
          packageLaunches,
          packageClosures,
          appPids,
          alive,
          peerClosed: !server.listening,
          cleanupErrors,
          failure:
            failure instanceof Error
              ? { message: failure.message, stack: failure.stack }
              : failure,
          pixels: await stat(paths.pixels)
            .then(async () => ({
              path: paths.pixels,
              sha256: await sha256File(paths.pixels),
            }))
            .catch(() => null),
        },
        null,
        2,
      ),
    );
    if (!failure) expect(cleanupErrors).toEqual([]);
  }
});
