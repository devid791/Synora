import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type CDPSession,
} from "playwright-core";
import { randomUUID } from "node:crypto";
import { browserURL } from "../shared/browser-url";
import { browserInspection } from "../main/browser-inspection";
import type { BrowserService } from "../main/service";
import type {
  BrowserTab,
  BrowserInput,
  DesktopEvent,
} from "../shared/contracts";

type Entry = {
  context: BrowserContext;
  page: Page;
  cdp: CDPSession;
  tab: BrowserTab;
};
// A separate sandboxed browser process. Remote documents never receive service credentials.
export class WebBrowser implements BrowserService {
  private browser?: Promise<Browser>;
  private entries = new Map<string, Entry>();
  private disposed = false;
  constructor(
    private emit: (e: DesktopEvent) => void,
    private servicePort: () => number,
    private executablePath?: string,
  ) {}
  private launch() {
    if (this.disposed) throw new Error("Browser service is closed");
    return (this.browser ??= chromium
      .launch({
        headless: true,
        chromiumSandbox: true,
        executablePath: this.executablePath,
        args: ["--disable-gpu"],
      })
      .catch((e) => {
        this.browser = undefined;
        throw e;
      }));
  }
  private target(value: string) {
    const result = browserURL(value),
      u = new URL(result);
    // The companion service is never a browsable remote tab, including hostname aliases.
    if (
      Number(u.port || (u.protocol === "https:" ? 443 : 80)) ===
      this.servicePort()
    )
      throw new Error(
        "The Synora service cannot be opened inside remote browser tabs",
      );
    return result;
  }
  private get(id: string) {
    const e = this.entries.get(id);
    if (!e) throw new Error("Unknown browser tab");
    return e;
  }
  list() {
    return [...this.entries.values()].map((e) => structuredClone(e.tab));
  }
  private changed() {
    this.emit({ kind: "browser", tabs: this.list() });
  }
  private notice(message: string) {
    this.emit({ kind: "notice", message });
  }
  private async sync(e: Entry) {
    if (!this.entries.has(e.tab.id)) return;
    const before = JSON.stringify(e.tab);
    try {
      const history = await e.cdp.send("Page.getNavigationHistory");
      e.tab.canGoBack = history.currentIndex > 0;
      e.tab.canGoForward = history.currentIndex < history.entries.length - 1;
      e.tab.title = (await e.page.title()) || "New tab";
      e.tab.url = e.page.url();
    } catch {
      /* A tab can close while its navigation finishes. */
    }
    if (this.entries.has(e.tab.id) && before !== JSON.stringify(e.tab))
      this.changed();
  }
  async open(value: string) {
    const url = this.target(value),
      browser = await this.launch();
    const context = await browser.newContext({
      acceptDownloads: false,
      permissions: [],
      serviceWorkers: "block",
      viewport: { width: 1000, height: 650 },
    });
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    if (!targetInfo.browserContextId) {
      await context.close();
      throw new Error("Browser isolation context unavailable");
    }
    // CDP grants the empty set and denies every other permission for this context.
    await cdp.send("Browser.grantPermissions", {
      permissions: [],
      browserContextId: targetInfo.browserContextId,
    });
    const tab: BrowserTab = {
      id: randomUUID(),
      url,
      title: "New tab",
      loading: false,
      error: null,
      canGoBack: false,
      canGoForward: false,
    };
    const e = { context, page, cdp, tab };
    this.entries.set(tab.id, e);
    await context.route("**/*", async (route) => {
      try {
        const request = route.request(),
          u = new URL(request.url());
        if (!["http:", "https:"].includes(u.protocol)) throw new Error();
        this.target(u.href);
        if (
          request.isNavigationRequest() &&
          request.frame().parentFrame() === null &&
          request.frame().page() !== page
        )
          throw new Error();
        await route.continue();
      } catch {
        await route.abort().catch(() => {});
      }
    });
    await context.routeWebSocket("**/*", (socket) => {
      const u = new URL(socket.url());
      if (
        Number(u.port || (u.protocol === "wss:" ? 443 : 80)) ===
        this.servicePort()
      )
        socket.close();
      else socket.connectToServer();
    });
    context.on("page", (popup) => {
      if (popup !== page) {
        void popup.close().catch(() => {});
        this.notice("Browser popup blocked. Open its address in a Synora tab.");
      }
    });
    page.on("download", (download) => {
      void download.cancel().catch(() => {});
      this.notice("Downloads are not enabled yet. No file was saved.");
    });
    page.on("dialog", (dialog) => {
      void dialog.dismiss().catch(() => {});
      this.notice("A browser page dialog was dismissed.");
    });
    page.on("crash", () => {
      tab.error = "Browser page crashed";
      tab.loading = false;
      this.changed();
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) void this.sync(e);
    });
    page.on("load", () => {
      tab.loading = false;
      this.changed();
      void this.sync(e);
    });
    await this.navigate(tab.id, url);
    return this.list();
  }
  private async navigation(e: Entry, fn: () => Promise<unknown>) {
    e.tab.loading = true;
    e.tab.error = null;
    this.changed();
    try {
      await fn();
    } catch (error) {
      e.tab.error =
        error instanceof Error ? error.message : "Navigation failed";
    } finally {
      e.tab.loading = false;
      await this.sync(e);
      if (this.entries.has(e.tab.id)) this.changed();
    }
  }
  async navigate(id: string, url: string) {
    const target = this.target(url),
      e = this.get(id);
    await this.navigation(e, () =>
      e.page.goto(target, { waitUntil: "domcontentloaded", timeout: 20000 }),
    );
  }
  async action(id: string, action: "back" | "forward" | "reload" | "close") {
    const e = this.get(id);
    if (action === "close") {
      this.entries.delete(id);
      await e.context.close();
      this.changed();
    } else
      await this.navigation(e, () =>
        action === "back"
          ? e.page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 })
          : action === "forward"
            ? e.page.goForward({
                waitUntil: "domcontentloaded",
                timeout: 20000,
              })
            : e.page.reload({ waitUntil: "domcontentloaded", timeout: 20000 }),
      );
    return this.list();
  }
  async layout(id: string | null, rect: { width: number; height: number }) {
    if (!id || rect.width < 1 || rect.height < 1) return;
    await this.get(id).page.setViewportSize({
      width: Math.max(320, Math.min(1920, Math.round(rect.width))),
      height: Math.max(200, Math.min(1080, Math.round(rect.height))),
    });
  }
  async frame(id: string) {
    const entry = this.get(id);
    await this.sync(entry);
    const page = entry.page,
      size = page.viewportSize()!;
    const bytes = await page.screenshot({
      type: "jpeg",
      quality: 75,
      timeout: 5000,
    });
    return {
      dataURL: `data:image/jpeg;base64,${bytes.toString("base64")}`,
      ...size,
    };
  }
  async inspect(id: string) {
    const entry = this.get(id);
    if (entry.tab.loading) throw Error("Page is still loading; wait for navigation before observing");
    return entry.page.evaluate(browserInspection) as Promise<{ url: string; title: string; text: string; elements: unknown[] }>;
  }
  async input(id: string, input: BrowserInput) {
    const page = this.get(id).page;
    if (input.type === "click")
      await page.mouse.click(input.x, input.y, { button: input.button });
    else if (input.type === "key") await page.keyboard.press(input.key);
    else if (input.type === "text") await page.keyboard.insertText(input.text);
    else {
      await page.mouse.move(input.x, input.y);
      await page.mouse.wheel(input.deltaX, input.deltaY);
    }
  }
  async dispose() {
    this.disposed = true;
    const browser = await this.browser?.catch(() => undefined);
    this.entries.clear();
    await browser?.close();
  }
}
