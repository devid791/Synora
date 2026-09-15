import { WebContentsView, session, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import type { BrowserTab, DesktopEvent } from "../shared/contracts";
import { browserURL } from "../shared/browser-url";
import { browserInspection } from "./browser-inspection";
import type { BrowserInput, BrowserFrame } from "../shared/contracts";

export class Browser {
  private entries = new Map<
    string,
    { view: WebContentsView; tab: BrowserTab; capture?: Promise<BrowserFrame> }
  >();
  constructor(
    private window: BrowserWindow,
    private emit: (event: DesktopEvent) => void,
  ) {}
  list() {
    return [...this.entries.values()].map((e) => structuredClone(e.tab));
  }
  private changed() {
    this.emit({ kind: "browser", tabs: this.list() });
  }
  private get(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new Error("Unknown browser tab");
    return e;
  }
  open(value: string) {
    const url = browserURL(value),
      id = randomUUID();
    const isolated = session.fromPartition(`synora-browser-${id}`);
    isolated.setPermissionCheckHandler(() => false);
    isolated.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(false);
      this.emit({
        kind: "notice",
        message: `Browser permission ${permission} is not enabled in this foundation.`,
      });
    });
    isolated.on("will-download", (event) => {
      event.preventDefault();
      this.emit({
        kind: "notice",
        message: "Downloads are not enabled yet. No file was saved.",
      });
    });
    isolated.webRequest.onBeforeRequest((details, callback) => {
      let allowed = false;
      try {
        allowed = [
          "http:",
          "https:",
          "ws:",
          "wss:",
          "data:",
          "blob:",
          "about:",
        ].includes(new URL(details.url).protocol);
      } catch {}
      callback({ cancel: !allowed });
    });
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    });
    const tab: BrowserTab = {
      id,
      title: "New tab",
      url,
      loading: true,
      error: null,
      canGoBack: false,
      canGoForward: false,
    };
    this.entries.set(id, { view, tab });
    this.window.contentView.addChildView(view);
    view.setBounds({ x: 0, y: 0, width: 1000, height: 650 });
    view.setVisible(false);
    const wc = view.webContents;
    const sync = () => {
      if (!this.entries.has(id) || wc.isDestroyed()) return;
      tab.title = wc.getTitle() || "New tab";
      tab.url = wc.getURL() || url;
      tab.loading = wc.isLoading();
      tab.canGoBack = wc.navigationHistory.canGoBack();
      tab.canGoForward = wc.navigationHistory.canGoForward();
      this.changed();
    };
    wc.setWindowOpenHandler(() => {
      this.emit({
        kind: "notice",
        message:
          "A browser popup was blocked. Open its address in a Synora tab.",
      });
      return { action: "deny" };
    });
    const validateNavigation = (event: Electron.Event, target: string) => {
      try {
        browserURL(target);
      } catch {
        event.preventDefault();
      }
    };
    wc.on("will-navigate", validateNavigation);
    wc.on("will-redirect", validateNavigation);
    wc.on("will-attach-webview", (event) => event.preventDefault());
    wc.on("did-start-loading", () => {
      tab.error = null;
      sync();
    });
    wc.on("did-stop-loading", sync);
    wc.on("did-navigate", sync);
    wc.on("did-navigate-in-page", sync);
    wc.on("page-title-updated", sync);
    wc.on("did-fail-load", (_event, code, message, _url, main) => {
      if (main && code !== -3) {
        tab.error = message;
        tab.loading = false;
        this.changed();
      }
    });
    wc.on("render-process-gone", (_event, details) => {
      tab.error = `Browser process ${details.reason}`;
      tab.loading = false;
      this.changed();
    });
    void wc.loadURL(url).catch((error) => {
      if (this.entries.has(id) && !wc.isDestroyed()) {
        tab.error = String(error.message);
        tab.loading = false;
        this.changed();
      }
    });
    this.changed();
    return this.list();
  }
  navigate(id: string, url: string) {
    const { view, tab } = this.get(id);
    const target = browserURL(url);
    tab.error = null;
    void view.webContents.loadURL(target).catch((e) => {
      if (this.entries.has(id)) {
        tab.error = e.message;
        tab.loading = false;
        this.changed();
      }
    });
  }
  async inspect(id: string) {
    const wc = this.get(id).view.webContents;
    if (wc.isLoading()) throw Error("Page is still loading; wait for navigation before observing");
    return wc.executeJavaScript(browserInspection, false);
  }
  async frame(id: string) {
    const entry = this.get(id);
    // The live preview and model may observe the same hidden view concurrently.
    // Share only an in-flight capture, never a cached/stale observation.
    const pending = entry.capture ??= (async () => {
      const wc = entry.view.webContents;
      // The page's CSS viewport is the common coordinate space for inspection,
      // screenshot pixels and CDP input. App UI zoom and page zoom are separate;
      // native view bounds belong only to layout, not to model coordinates.
      const viewport = () => wc.executeJavaScript("({width:innerWidth,height:innerHeight})", false);
      const before = await viewport();
      const image = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true });
      if (image.isEmpty()) throw Error("Browser frame is unavailable");
      const after = await viewport();
      if (before.width !== after.width || before.height !== after.height || before.width <= 0 || before.height <= 0)
        throw Error("Browser viewport changed while capturing; take a fresh snapshot");
      const normalized = image.resize({ width: before.width, height: before.height });
      return { dataURL: `data:image/jpeg;base64,${normalized.toJPEG(80).toString("base64")}`, width: before.width, height: before.height };
    })();
    try { return await pending; }
    finally { if (entry.capture === pending) entry.capture = undefined; }
  }
  async input(id: string, input: BrowserInput) {
    const wc = this.get(id).view.webContents;
    // The side panel displays this isolated page as an actual native child.
    // Electron sendInputEvent silently loses input when its native child view
    // is hidden. Fixed CDP Input commands deliver real DOM events in that page
    // without stealing focus from the chat or exposing a debugging TCP port.
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    const send = (method: string, args: Record<string, unknown>) => wc.debugger.sendCommand(method, args);
    if (input.type === "text") await send("Input.insertText", { text: input.text });
    else if (input.type === "key") {
      const parts = input.key.split("+"), key = parts.pop()!;
      const codes: Record<string, number> = { Enter:13,Tab:9,Escape:27,Backspace:8,Delete:46,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,Home:36,End:35,PageUp:33,PageDown:34,a:65 };
      const modifiers = parts.reduce((n,p)=>n | (p === "Control" ? 2 : p === "Meta" ? 4 : 8),0);
      const args = { key, code: key === "a" ? "KeyA" : key, windowsVirtualKeyCode:codes[key], modifiers };
      await send("Input.dispatchKeyEvent", { type:"keyDown", ...args, ...(key === "Enter" ? {text:"\r"} : {}), ...(key === "a" && modifiers ? {commands:["selectAll"]} : {}) });
      await send("Input.dispatchKeyEvent", { type:"keyUp", ...args });
    } else {
      const point = { x:input.x,y:input.y };
      await send("Input.dispatchMouseEvent", { type:"mouseMoved",...point });
      if (input.type === "click") {
        await send("Input.dispatchMouseEvent", { type:"mousePressed",...point,button:input.button,clickCount:1 });
        await send("Input.dispatchMouseEvent", { type:"mouseReleased",...point,button:input.button,clickCount:1 });
      } else await send("Input.dispatchMouseEvent", {type:"mouseWheel",...point,deltaX:input.deltaX,deltaY:input.deltaY});
    }
  }
  action(id: string, action: "back" | "forward" | "reload" | "close") {
    const { view } = this.get(id);
    const wc = view.webContents;
    if (action === "close") {
      this.entries.delete(id);
      this.window.contentView.removeChildView(view);
      wc.close({ waitForBeforeUnload: false });
    } else if (action === "reload") wc.reload();
    else if (action === "back" && wc.navigationHistory.canGoBack())
      wc.navigationHistory.goBack();
    else if (action === "forward" && wc.navigationHistory.canGoForward())
      wc.navigationHistory.goForward();
    this.changed();
    return this.list();
  }
  layout(
    id: string | null,
    rect: { x: number; y: number; width: number; height: number },
  ) {
    if (id) this.get(id);
    const [width, height] = this.window.getContentSize();
    // Renderer rectangles are CSS pixels; native child bounds are device-independent
    // pixels. The two differ when the operator zooms the application UI.
    const zoom = this.window.webContents.getZoomFactor();
    const x = Math.min(width, Math.max(0, Math.round(rect.x * zoom))),
      y = Math.min(height, Math.max(0, Math.round(rect.y * zoom)));
    for (const [key, { view }] of this.entries) {
      view.setVisible(key === id && rect.width > 0 && rect.height > 0);
      if (key === id)
        view.setBounds({
          x,
          y,
          width: Math.max(
            0,
            Math.min(Math.round(rect.width * zoom), width - x),
          ),
          height: Math.max(
            0,
            Math.min(Math.round(rect.height * zoom), height - y),
          ),
        });
    }
  }
  dispose() {
    for (const id of [...this.entries.keys()]) this.action(id, "close");
  }
}
