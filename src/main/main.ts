import {
  app,
  BrowserWindow,
  protocol,
  net,
  ipcMain,
  dialog,
  session,
  shell,
  safeStorage,
  Notification,
  nativeTheme,
  clipboard,
} from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Browser } from "./browser";
import { LocalService } from "./service";
import { lifecycleContent, loginItemHook } from "./native-preferences";
import { getNativeMessages } from "./native-messages";
import { operations } from "../shared/operations";
import type { DesktopEvent } from "../shared/contracts";

protocol.registerSchemesAsPrivileged([
  {
    scheme: "synora",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);
app.setName("Synora Harness Desktop");
if (process.platform === "win32") app.setAppUserModelId("org.synora.harness.desktop");
// An explicit separate data path supports disposable QA and portable local installs.
if (process.env.SYNORA_DATA_DIR)
  app.setPath("userData", path.resolve(process.env.SYNORA_DATA_DIR));
let service: LocalService | undefined,
  window: BrowserWindow | undefined,
  quitting = false;
let closeRequested = false;
let rendererReady = false;
let pendingClose: { id: string; resolve: (dirty: boolean) => void } | null =
  null;
const nativeMessages = () =>
  getNativeMessages(() => service?.store.read().preferences.locale);
async function start() {
  await app.whenReady();
  const root = path.join(__dirname, "renderer");
  protocol.handle("synora", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.host !== "app" || request.method !== "GET")
        return new Response("Not found", { status: 404 });
      const relative = decodeURIComponent(url.pathname).replace(/^\/+/, ""),
        target = path.resolve(root, relative || "index.html");
      if (!target.startsWith(root + path.sep))
        return new Response("Forbidden", { status: 403 });
      return await net.fetch(pathToFileURL(target).href);
    } catch {
      return new Response("Not found", { status: 404 });
    }
  });
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_wc, _p, callback) =>
    callback(false),
  );
  window = new BrowserWindow({
    width: 1480,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    backgroundColor: "#151619",
    title: "Synora Harness Desktop",
    icon: path.join(root, "brand", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      webviewTag: false,
    },
  });
  const emit = (event: DesktopEvent) => {
    if (window && !window.isDestroyed())
      window.webContents.send("synora:event", event);
  };
  const browser = new Browser(window, emit);
  service = new LocalService(
    path.join(app.getPath("userData"), "state.sqlite"),
    {
      setTheme: theme => { nativeTheme.themeSource = theme; },
      ...(app.isPackaged && !process.env.SYNORA_DATA_DIR && (process.platform === "darwin" || process.platform === "win32") ? {
        launchAtLogin: loginItemHook(app, process.platform, process.execPath),
        ...(Notification.isSupported() ? {
          notify: (kind: keyof typeof lifecycleContent) => {
            const notification = new Notification({ ...lifecycleContent[kind], silent: true });
            notification.on("failed", () => emit({ kind: "notice", message: "The operating system could not display a Synora notification. Check system notification settings." }));
            notification.show();
          },
        } : {}),
      } : {}),
      closeReady: (id, dirty) => {
        if (!pendingClose || pendingClose.id !== id)
          throw new Error("Stale close acknowledgement");
        pendingClose.resolve(dirty);
        pendingClose = null;
      },
      openAuthorizationUrl: (url) => shell.openExternal(url),
      clipboardWriteText: (text) => clipboard.writeText(text),
      credentialCipher:
        safeStorage.isEncryptionAvailable() &&
        (process.platform !== "linux" ||
          ["gnome_libsecret", "kwallet", "kwallet5", "kwallet6"].includes(
            safeStorage.getSelectedStorageBackend(),
          ))
          ? {
              seal: (value) => safeStorage.encryptString(value),
              open: (value) => safeStorage.decryptString(value),
            }
          : undefined,
      capabilities: {
        platform: process.platform as "linux" | "win32" | "darwin",
        transport: "desktop-ipc",
        nativeDialogs: true,
        terminal: true,
        embeddedBrowser: true,
        engine: "simulated",
        liveInference: false,
      },
      browser,
      chooseWorkspace: async () => {
        const messages = nativeMessages();
        const result = await dialog.showOpenDialog(window!, {
          title: messages.workspaceTitle,
          buttonLabel: messages.workspaceButton,
          properties: ["openDirectory"],
        });
        return result.canceled ? null : result.filePaths[0];
      },
      importPreset: async () => {
        const messages = nativeMessages();
        const result = await dialog.showOpenDialog(window!, {
          title: messages.importTitle,
          buttonLabel: messages.importButton,
          properties: ["openFile"],
          filters: [{ name: messages.presetFilter, extensions: ["json"] }],
        });
        if (result.canceled) return null;
        const file = result.filePaths[0];
        if ((await fs.stat(file)).size > 65536)
          throw new Error(nativeMessages().presetTooLarge);
        return JSON.parse(await fs.readFile(file, "utf8"));
      },
      exportPreset: async (value, name) => {
        const messages = nativeMessages();
        const result = await dialog.showSaveDialog(window!, {
          title: messages.exportTitle,
          buttonLabel: messages.exportButton,
          defaultPath: `${name.replace(/[^a-z0-9-]/gi, "-")}.json`,
          filters: [{ name: messages.presetFilter, extensions: ["json"] }],
        });
        if (result.canceled || !result.filePath) return false;
        await fs.writeFile(
          result.filePath,
          JSON.stringify(value, null, 2) + "\n",
          { mode: 0o600 },
        );
        return true;
      },
    },
    emit,
  );
  for (const operation of operations)
    ipcMain.handle(`synora:${operation}`, (event, ...args) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame ||
        event.senderFrame.url !== "synora://app/index.html"
      )
        return {
          ok: false,
          error: {
            code: "UNTRUSTED_SENDER",
            message:
              "Only the packaged Synora main frame can use desktop services",
          },
        };
      rendererReady = true;
      return service!.invoke(operation, args);
    });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("render-process-gone", () => {
    rendererReady = false;
  });
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.once("ready-to-show", () => window?.show());
  window.on("close", (event) => {
    if (!quitting) {
      event.preventDefault();
      app.quit();
    }
  });
  await window.loadURL("synora://app/index.html");
}
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  if (closeRequested) return;
  closeRequested = true;
  void (async () => {
    try {
      if (
        rendererReady &&
        window &&
        !window.isDestroyed() &&
        !window.webContents.isLoading()
      ) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        let dirty: boolean;
        try {
          dirty = await Promise.race([
            new Promise<boolean>((resolve) => {
              const id = randomUUID();
              pendingClose = { id, resolve };
              window!.webContents.send("synora:event", {
                kind: "prepare-close",
                id,
              } satisfies DesktopEvent);
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(new Error(nativeMessages().draftSaveTimeout)),
                5000,
              );
            }),
          ]);
        } finally {
          if (timer) clearTimeout(timer);
          pendingClose = null;
        }
        if (dirty) {
          const messages = nativeMessages();
          const answer = await dialog.showMessageBox(window, {
            type: "warning",
            title: messages.unsavedTitle,
            message: messages.unsavedMessage,
            detail: messages.unsavedDetail,
            buttons: messages.unsavedButtons,
            defaultId: 0,
            cancelId: 0,
          });
          if (answer.response !== 1) {
            closeRequested = false;
            return;
          }
        }
      }
      await service?.dispose();
      quitting = true;
      app.quit();
    } catch (error) {
      console.error("Synora local cleanup failed:", error);
      closeRequested = false;
      if (window && !window.isDestroyed())
        window.webContents.send("synora:event", {
          kind: "notice",
          message:
            error instanceof Error
              ? error.message
              : nativeMessages().closeFailed,
        } satisfies DesktopEvent);
    }
  })();
});
app.on("window-all-closed", () => app.quit());
start().catch((error) => {
  console.error("Synora startup failed:", error);
  app.quit();
});
