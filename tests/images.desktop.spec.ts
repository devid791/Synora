import {
  test,
  expect,
  _electron,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdtemp, mkdir, writeFile, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { Resvg } from "@resvg/resvg-js";
import type { AppState, EngineSnapshot } from "../src/shared/contracts";
import { qualifyImageVisual } from "./fixtures/image-native-visual";
import { verifyCandidateFiles } from "./fixtures/native-provider-candidate.mjs";

test("Native image IPC, draft removal/restart, actual Axiom vision and cold history at 150%", async () => {
  const windows = process.platform === "win32";
  const prepared = process.env.SYNORA_TEST_PREPARED_WINDOWS_QA;
  let verifyPrepared = async () => {};
  if (windows || prepared) {
    expect(windows, "Prepared Windows home is Windows-only").toBe(true);
    expect(
      prepared,
      "Windows requires explicit in-place prepared QA opt-in",
    ).toBe(
      "C:\\Users\\axiom-builder\\AppData\\Local\\Temp\\synora-live-native-Mb5PPy",
    );
    for (const key of [
      "SYNORA_CODEX_BINARY",
      "SYNORA_CORE_CACHE",
      "SYNORA_AUTHORIZE_WINDOWS_SETUP",
    ])
      expect(process.env[key], `No runtime override/setup: ${key}`).toBeFalsy();
    const candidates = [
      {
        id: "6abb5b9",
        root: "C:\\Synora_QA_6abb5b9_20260910_2e1a753a1d8a",
        executable:
          "0178f51ced5f1923cc58b7876692317b220df7d81a6a2cd7587c54da0695727d",
        asar: "cdd59de23a53c5fbab17ebe86925666c996ea18a82ee977f81c11a9f43c12c02",
      },
      {
        id: "ac17c1c",
        root: "C:\\Synora_QA_ac17c1c_20260910_c05c8a76b463",
        executable:
          "2875aac8009caf890f44f02253930923f730a2dabd76cac95ce6b685f816b32f",
        asar: "74ff72a6bb0a5edb52a3bfad93645190ea437ff70761b4922f22bdb693afb19f",
      },
    ];
    const candidate = candidates.find(
      (entry) => entry.root === resolve(process.cwd()),
    );
    expect(
      candidate,
      "Exact independently verified Windows QA candidate",
    ).toBeTruthy();
    const { root } = candidate!;
    const executable = join(
      root,
      `out/production-qa-windows-${candidate!.id}/win-unpacked/Synora Harness Desktop.exe`,
    );
    expect(process.env.SYNORA_TEST_EXECUTABLE).toBe(executable);
    expect(process.env.SYNORA_TEST_ENDPOINT).toBe(
      "http://10.23.45.10:8015/codex/v1",
    );
    const data = join(prepared!, "state");
    const files = [
      [executable, candidate!.executable],
      [
        join(
          root,
          `out/production-qa-windows-${candidate!.id}/win-unpacked/resources/app.asar`,
        ),
        candidate!.asar,
      ],
      [
        join(
          data,
          "core-runtime/0.153.4-x86_64-pc-windows-msvc-a6ef3442cb12766a/bin/codex.exe",
        ),
        "444a3f0008050605cae73cd9b7a2dcac61294062dfaab56dd20430fd6498518b",
      ],
      [
        join(data, "app-server/.windows-home.json"),
        "076351d7ede73b7d986135ab81ede4f5d849dd667d71b4ca4227ffd7653655b4",
      ],
      [
        join(
          data,
          "app-server/native-axiom/.sandbox-secrets/sandbox_users.json",
        ),
        "e4a62e26a2d84d09696946d8b65c3737529e48e0da7aa5e98cea3bfed25edb1f",
      ],
      [
        join(data, "app-server/native-axiom/.sandbox/setup_marker.json"),
        "a9293d6c496acef647603f309ad9cb4381f8a8def437f1444f0102a03c7a4d02",
      ],
    ].map(([path, sha256]) => ({ path, sha256 }));
    // Existing read-only verifier rejects redirected/noncanonical paths and
    // hashes bytes without copying or disclosing private Core files.
    verifyPrepared = async () => {
      await verifyCandidateFiles({
        candidate: candidate!.id,
        platform: "win32",
        root,
        config: "playwright.images-desktop.config.ts",
        executable,
        files,
      });
    };
    await verifyPrepared();
  }
  const fixtureDir = await mkdtemp(join(tmpdir(), "synora-image-native-")),
    dir = windows ? resolve(prepared!) : fixtureDir;
  let workspace = join(fixtureDir, "workspace");
  const provider = windows
    ? `image-native-axiom-${randomUUID()}`
    : "image-native-axiom";
  await mkdir(workspace);
  // Match the application's registered realpath even with Session1's 8.3
  // temporary-directory alias; never override TMP/TEMP or weaken equality.
  if (windows) workspace = await realpath(workspace);
  const [color, hex] = [
    ["BLUE", "#0044ff"],
    ["RED", "#ee0000"],
    ["GREEN", "#00bb22"],
  ][randomInt(3)];
  const png = new Resvg(
    `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="384"><rect width="512" height="384" fill="${hex}"/><circle cx="256" cy="192" r="40" fill="#fff"/></svg>`,
  )
    .render()
    .asPng();
  let app: ElectronApplication | undefined, page: Page;
  let latest: EngineSnapshot | undefined;
  const errors: string[] = [];
  let prior: AppState | undefined, conversationId: string | undefined;
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
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await expect(
      page.getByRole("button", { name: "Workspace", exact: true }),
    ).toBeVisible();
  };
  const nav = (name: string) =>
    page.getByRole("button", { name, exact: true }).click();
  const state = () =>
    page.evaluate(async () => {
      const r = await window.synora.state();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
  const snapshot = async () => {
    latest = await page.evaluate(async () => {
      const r = await window.synora.engineSnapshot();
      if (!r.ok) throw Error(r.error.message);
      return r.value;
    });
    return latest;
  };
  const conversation = async () => {
    const s = await state();
    if (!windows) return s.conversations[0];
    const current = s.conversations.find((c) => c.id === conversationId);
    expect(current, "Exact newly owned image conversation").toBeTruthy();
    return current!;
  };
  const preservePrior = async () => {
    if (!prior) return;
    const s = await state();
    for (const c of prior.conversations)
      expect(s.conversations.find((x) => x.id === c.id)).toEqual(c);
    for (const w of prior.workspaces)
      expect(s.workspaces.find((x) => x.id === w.id)).toEqual(w);
    for (const i of prior.integrations)
      expect(s.integrations.find((x) => x.id === i.id)).toEqual(i);
  };
  const restoredLive = async () => {
    if (windows) {
      await expect
        .poll(async () => (await snapshot()).connection, { timeout: 30000 })
        .toBe("live");
      expect((await snapshot()).error).toBeNull();
    }
  };
  const complete = (timeout: number) =>
    expect
      .poll(
        async () => {
          const s = await snapshot();
          if (s.status === "failed") throw Error(JSON.stringify(s.error));
          return s.status;
        },
        { timeout },
      )
      .toBe("completed");
  const attach = () =>
    page
      .getByLabel("Attach image files")
      .setInputFiles({ name: "scene.png", mimeType: "image/png", buffer: png });
  try {
    await launch();
    if (windows) {
      await restoredLive();
      await complete(30000);
      prior = await state();
      // Add workspace rebinds the selected conversation. Create a NEW one
      // first; never move historical QA conversations or their selections.
      await nav("New conversation");
      await expect
        .poll(async () => (await state()).conversations.length)
        .toBe(prior.conversations.length + 1);
      conversationId = (await state()).conversations.find(
        (c) => !prior!.conversations.some((old) => old.id === c.id),
      )!.id;
    }
    await app!.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [path],
      })) as typeof dialog.showOpenDialog;
    }, workspace);
    await nav("Add workspace");
    if (windows) {
      const current = await conversation();
      expect(
        (await state()).workspaces.find((w) => w.id === current.workspaceId)
          ?.path,
      ).toBe(workspace);
      await preservePrior();
    }
    await nav("Models & accounts");
    await nav("Add configuration");
    await page!.getByLabel("Configuration ID").fill(provider);
    await page!
      .getByLabel("Configuration name")
      .fill("Native image qualification");
    await page!
      .getByLabel("Configuration endpoint")
      .fill(process.env.SYNORA_TEST_ENDPOINT!);
    await page!.getByLabel("Enable configuration").check();
    await nav("Save configuration");
    await nav("Settings");
    await page!.getByLabel("Engine provider").selectOption(provider);
    await nav("Read live model catalog");
    await nav("Use live Axiom");
    await nav("Workspace");
    await attach();
    await expect(
      page!.getByLabel("Draft images").getByRole("img", { name: "scene.png" }),
    ).toBeVisible();
    await nav("Remove image scene.png");
    await expect
      .poll(async () => (await conversation()).draftImageIds?.length)
      .toBe(0);
    await attach();
    await expect(
      page!.getByLabel("Draft images").getByRole("img", { name: "scene.png" }),
    ).toBeVisible();
    const before = await conversation(),
      image = before.attachments![0];
    expect(before.attachments).toHaveLength(1);
    expect(image.sha256).toBe(createHash("sha256").update(png).digest("hex"));
    expect(JSON.stringify(before)).not.toContain(png.toString("base64"));
    await app!.close();
    app = undefined;
    await launch();
    // This is a draft-only conversation: there is no live binding until Send.
    await expect(
      page!.getByLabel("Draft images").getByRole("img", { name: "scene.png" }),
    ).toBeVisible();
    await page!
      .getByLabel("Message", { exact: true })
      .fill(
        "Look only at the attached image. What color covers the largest area? Reply with just the color name in English. Do not use tools.",
      );
    await nav("Send message");
    await complete(120000);
    const completed = await snapshot(),
      completedConversation = await conversation();
    await expect(page!.locator(".message.assistant").last()).toContainText(
      new RegExp(color, "i"),
    );
    expect(
      completed.items.some(
        (i) => i.type === "commandExecution" || i.type === "mcpToolCall",
      ),
    ).toBe(false);
    expect(completed.firstDeltaAt).toBeLessThan(completed.completedAt!);
    expect(completed.backendRequests?.length).toBeGreaterThan(0);
    expect(completedConversation.draftImageIds).toEqual([]);
    expect(
      completedConversation.messages.find((m) => m.role === "user")?.imageIds,
    ).toEqual([image.id]);
    await qualifyImageVisual(
      app!,
      page!,
      "test-results/images-desktop/actual-image-150.png",
    );
    await app!.close();
    app = undefined;
    await launch();
    await restoredLive();
    await complete(30000);
    const restored = await snapshot();
    expect(restored.sessionId).toBe(completed.sessionId);
    expect(restored.threadId).toBe(completed.threadId);
    const restoredConversation = await conversation();
    expect(
      restoredConversation.messages.find((m) => m.role === "user")?.imageIds,
    ).toEqual([image.id]);
    await expect(page!.locator(".message.user img")).toHaveCount(1);
    await expect(page!.locator(".message.user img")).toBeVisible();
    if (windows) {
      expect(completed.conversationId).toBe(conversationId);
      expect(restored.conversationId).toBe(conversationId);
      await preservePrior();
      await verifyPrepared();
    }
    expect(errors).toEqual([]);
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/image-native-actual.json",
      JSON.stringify(
        {
          passed: true,
          dir,
          ...(windows
            ? {
                fixtureDir,
                workspace,
                conversationId,
                provider,
                preparedWindows: true,
              }
            : {}),
          image,
          color,
          completed,
          restored,
          errors,
          executable: process.env.SYNORA_TEST_EXECUTABLE ?? null,
          scope:
            "Actual native Electron/Core/Axiom image request; no public provider or other-platform claim",
        },
        null,
        2,
      ),
    );
  } catch (error) {
    await mkdir("out/live-evidence", { recursive: true });
    await writeFile(
      "out/live-evidence/image-native-failure.json",
      JSON.stringify(
        {
          dir,
          ...(windows
            ? {
                fixtureDir,
                workspace,
                conversationId,
                provider,
                preparedWindows: true,
              }
            : {}),
          error: String(error),
          color,
          latest,
          errors,
        },
        null,
        2,
      ),
    );
    throw error;
  } finally {
    await app?.close();
  }
});
