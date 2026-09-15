import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import ts from "typescript";
import { nativeCredentialCipher } from "../src/main/native-credential-cipher";
import { localeSchema, type Locale } from "../src/shared/locale";
import {
  getNativeMessages,
  nativeMessageCatalog,
} from "../src/main/native-messages";
import {
  lifecycleContent,
  loginItemHook,
} from "../src/main/native-preferences";

test("Native catalog covers exactly the saved locales, with every message translated", () => {
  assert.deepEqual(Object.keys(nativeMessageCatalog), localeSchema.options);
  assert.deepEqual(localeSchema.options, [
    "en",
    "it",
    "fr",
    "de",
    "es",
    "pt",
    "nl",
  ]);
  const keys = Object.keys(nativeMessageCatalog.en);
  for (const locale of localeSchema.options) {
    const messages = nativeMessageCatalog[locale];
    assert.deepEqual(Object.keys(messages), keys);
    for (const key of keys as (keyof typeof messages)[]) {
      const values = [messages[key]].flat();
      assert.ok(
        values.every((value) => typeof value === "string" && value.trim()),
        `${locale}.${key}`,
      );
      if (locale !== "en")
        assert.notDeepEqual(
          messages[key],
          nativeMessageCatalog.en[key],
          `${locale}.${key}`,
        );
    }
  }
  assert.match(nativeMessageCatalog.pt.unsavedTitle, /ficheiro/);
  assert.match(nativeMessageCatalog.pt.importTitle, /predefinição/);
});

test("Native warning buttons retain keep-editing index 0 and discard-and-quit index 1 in every language", () => {
  const expected: Record<Locale, [string, string]> = {
    en: ["Keep editing", "Discard and quit"],
    it: ["Continua a modificare", "Scarta ed esci"],
    fr: ["Continuer à modifier", "Abandonner et quitter"],
    de: ["Weiter bearbeiten", "Verwerfen und beenden"],
    es: ["Seguir editando", "Descartar y salir"],
    pt: ["Continuar a editar", "Descartar e sair"],
    nl: ["Verder bewerken", "Verwerpen en afsluiten"],
  };
  for (const locale of localeSchema.options)
    assert.deepEqual(
      getNativeMessages(() => locale).unsavedButtons,
      expected[locale],
    );
});

test("Native language lookup reads each invocation and safely falls back to English", () => {
  let locale: unknown;
  let reads = 0;
  const readLocale = () => {
    reads++;
    return locale;
  };
  assert.equal(getNativeMessages(readLocale), nativeMessageCatalog.en);
  for (const saved of localeSchema.options) {
    locale = saved;
    assert.equal(getNativeMessages(readLocale), nativeMessageCatalog[saved]);
  }
  assert.equal(reads, 8);
  for (const invalid of [
    null,
    "",
    "pt-PT",
    "pt-BR",
    "EN",
    "toString",
    "__proto__",
    {},
    1,
  ])
    assert.equal(
      getNativeMessages(() => invalid),
      nativeMessageCatalog.en,
    );
  assert.equal(
    getNativeMessages(() => {
      throw new Error("Store unavailable");
    }),
    nativeMessageCatalog.en,
  );
});

// Execute the real main entrypoint with in-memory Electron/service doubles only.
// No app, database, filesystem dialog, engine, or external service is started.
const mainCode = ts.transpileModule(
  readFileSync(new URL("../src/main/main.ts", import.meta.url), "utf8"),
  {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  },
).outputText;
const require = createRequire(import.meta.url);
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
interface NativeHooks {
  clipboardWriteText(text: string): void;
  chooseWorkspace(): Promise<string | null>;
  importPreset(): Promise<unknown>;
  exportPreset(value: unknown, name: string): Promise<boolean>;
  closeReady(id: string, dirty: boolean): void;
}
async function mainHarness() {
  const state = {
    locale: "en" as unknown,
    reads: 0,
    disposed: 0,
    quit: 0,
    response: 0,
    dirty: true,
    acknowledge: true,
    failDispose: false,
    disposeError: undefined as unknown,
    storeUnavailable: false,
  };
  let hooks!: NativeHooks;
  let handler!: (event: unknown) => unknown;
  let timeout: (() => void) | undefined;
  const dialogs: { kind: string; options: Record<string, unknown> }[] = [];
  const notices: string[] = [];
  const errors: unknown[][] = [];
  const clipboardWrites: string[] = [];
  const invocations: unknown[][] = [];
  const frame = { url: "synora://app/index.html" };
  const webContents = {
    mainFrame: frame,
    isLoading: () => false,
    on() {},
    setWindowOpenHandler() {},
    send(
      _channel: string,
      event: { kind: string; id: string; message: string },
    ) {
      if (event.kind === "prepare-close" && state.acknowledge)
        hooks.closeReady(event.id, state.dirty);
      if (event.kind === "notice") notices.push(event.message);
    },
  };
  const app = Object.assign(new EventEmitter(), {
    setName() {},
    setPath() {},
    getPath: () => "/unused-native-message-test",
    whenReady: async () => {},
    quit: () => {
      state.quit++;
    },
  });
  const electron = {
    globalShortcut: { register: () => true, unregister() {} },
    clipboard: { writeText(text: string) { clipboardWrites.push(text); } },
    app,
    BrowserWindow: class extends EventEmitter {
      webContents = webContents;
      isDestroyed() {
        return false;
      }
      async loadURL() {}
    },
    protocol: { registerSchemesAsPrivileged() {}, handle() {} },
    session: {
      defaultSession: {
        setPermissionCheckHandler() {},
        setPermissionRequestHandler() {},
      },
    },
    safeStorage: { isEncryptionAvailable: () => false },
    ipcMain: {
      handle(_operation: string, callback: typeof handler) {
        handler = callback;
      },
    },
    dialog: Object.fromEntries(
      ["showOpenDialog", "showSaveDialog", "showMessageBox"].map((kind) => [
        kind,
        async (_window: unknown, options: Record<string, unknown>) => {
          dialogs.push({ kind, options: JSON.parse(JSON.stringify(options)) });
          return { canceled: true, response: state.response };
        },
      ]),
    ),
  };
  const service = {
    LocalService: class {
      store = {
        read: () => {
          state.reads++;
          if (state.storeUnavailable) throw new Error("Store unavailable");
          return { preferences: { locale: state.locale } };
        },
      };
      constructor(_path: string, options: NativeHooks) {
        hooks = options;
      }
      invoke(...args: unknown[]) { invocations.push(args); return { ok: true }; }
      async dispose() {
        if (state.failDispose) throw state.disposeError;
        state.disposed++;
      }
    },
  };
  runInNewContext(mainCode, {
    exports: {},
    __dirname: "/unused-native-message-test",
    Error,
    process: { env: {}, platform: "linux" },
    console: {
      error(...args: unknown[]) {
        errors.push(args);
      },
    },
    setTimeout(callback: () => void) {
      timeout = callback;
      return 1;
    },
    clearTimeout() {
      timeout = undefined;
    },
    require(id: string) {
      if (id === "electron") return electron;
      if (id === "./service") return service;
      if (id === "./browser") return { Browser: class {} };
      if (id === "./computer-native") return { NativeComputer: class {} };
      if (id === "./native-credential-cipher") return { nativeCredentialCipher };
      if (id === "./native-messages") return { getNativeMessages };
      // Load the real pure helpers added to main; this Linux/in-memory harness
      // never enters the packaged macOS/Windows login-item branch.
      if (id === "./native-preferences") return { lifecycleContent, loginItemHook };
      if (id === "../shared/operations") return { operations: ["test"] };
      assert.ok(id.startsWith("node:"), `Unexpected main dependency: ${id}`);
      return require(id);
    },
  });
  await settle();
  assert.deepEqual(errors, [], "Main startup must succeed in the harness");
  handler({ sender: webContents, senderFrame: frame });
  return {
    state,
    hooks,
    dialogs,
    notices,
    clipboardWrites,
    invocations,
    invokeFrom: (sender: unknown, senderFrame: unknown) => handler({ sender, senderFrame }),
    webContents,
    frame,
    async close() {
      app.emit("before-quit", { preventDefault() {} });
      await settle();
    },
    async expireClose() {
      assert.ok(timeout);
      timeout();
      await settle();
    },
  };
}

test("Native clipboard host writes exact text while privileged IPC rejects remote and child frames", async () => {
  const h = await mainHarness();
  h.hooks.clipboardWriteText("Original\nCittà 🛰️");
  assert.deepEqual(h.clipboardWrites, ["Original\nCittà 🛰️"]);
  const before = h.invocations.length;
  for (const [sender, frame] of [[{}, h.frame], [h.webContents, { url: "synora://app/index.html" }], [h.webContents, { url: "https://example.com" }]]) {
    const result = h.invokeFrom(sender, frame) as any;
    assert.equal(result.ok, false); assert.equal(result.error.code, "UNTRUSTED_SENDER");
  }
  assert.equal(h.invocations.length, before);
});
test("Actual main dialogs use current saved locale and retain picker/filter/cancellation semantics", async () => {
  const h = await mainHarness();
  for (const locale of localeSchema.options) {
    h.state.locale = locale;
    const messages = nativeMessageCatalog[locale];
    assert.equal(await h.hooks.chooseWorkspace(), null);
    assert.equal(await h.hooks.importPreset(), null);
    assert.equal(
      await h.hooks.exportPreset({ untranslated: "user text" }, "User Name"),
      false,
    );
    const [workspace, imported, exported] = h.dialogs.splice(0);
    assert.deepEqual(workspace, {
      kind: "showOpenDialog",
      options: {
        title: messages.workspaceTitle,
        buttonLabel: messages.workspaceButton,
        properties: ["openDirectory"],
      },
    });
    assert.deepEqual(imported, {
      kind: "showOpenDialog",
      options: {
        title: messages.importTitle,
        buttonLabel: messages.importButton,
        properties: ["openFile"],
        filters: [{ name: messages.presetFilter, extensions: ["json"] }],
      },
    });
    assert.deepEqual(exported, {
      kind: "showSaveDialog",
      options: {
        title: messages.exportTitle,
        buttonLabel: messages.exportButton,
        defaultPath: "User-Name.json",
        filters: [{ name: messages.presetFilter, extensions: ["json"] }],
      },
    });
  }
  assert.equal(h.state.reads, 21);
  h.state.storeUnavailable = true;
  await h.hooks.chooseWorkspace();
  assert.equal(
    h.dialogs[0].options.title,
    nativeMessageCatalog.en.workspaceTitle,
  );
});

test("Actual close flow retains default/cancel 0 and requires explicit response 1 in all seven locales", async () => {
  for (const locale of localeSchema.options) {
    const h = await mainHarness();
    h.state.locale = locale;
    const messages = nativeMessageCatalog[locale];
    await h.close();
    assert.deepEqual(h.dialogs[0], {
      kind: "showMessageBox",
      options: {
        type: "warning",
        title: messages.unsavedTitle,
        message: messages.unsavedMessage,
        detail: messages.unsavedDetail,
        buttons: messages.unsavedButtons,
        defaultId: 0,
        cancelId: 0,
      },
    });
    assert.equal(h.state.disposed, 0);
    assert.equal(h.state.quit, 0);
    h.state.response = -1;
    await h.close();
    assert.equal(h.state.disposed, 0);
    assert.equal(h.state.quit, 0);
    h.state.response = 1;
    await h.close();
    assert.equal(h.state.disposed, 1);
    assert.equal(h.state.quit, 1);
  }
});

test("Close timeout and fallback notices localize without discarding or masking original errors", async () => {
  for (const locale of localeSchema.options) {
    const h = await mainHarness();
    h.state.acknowledge = false;
    await h.close();
    h.state.locale = locale;
    await h.expireClose();
    assert.equal(
      h.notices.pop(),
      nativeMessageCatalog[locale].draftSaveTimeout,
    );
    assert.equal(h.state.disposed, 0);
    assert.equal(h.state.quit, 0);
    assert.equal(h.dialogs.length, 0);
    h.state.acknowledge = true;
    h.state.dirty = false;
    h.state.failDispose = true;
    await h.close();
    assert.equal(h.notices.pop(), nativeMessageCatalog[locale].closeFailed);
    h.state.disposeError = new Error("Original upstream error / user content");
    await h.close();
    assert.equal(h.notices.pop(), "Original upstream error / user content");
    assert.equal(h.state.quit, 0);
    h.state.failDispose = false;
    await h.close();
    assert.equal(h.state.disposed, 1);
    assert.equal(h.state.quit, 1);
  }
});
