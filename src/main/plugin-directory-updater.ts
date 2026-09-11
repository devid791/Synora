import type { PluginDirectory } from "./plugin-directory";

/** Public metadata only. No relationship to engine admission, credentials,
 * installed plugin manifests or the user's mounted tool inventory. */
export class PluginDirectoryUpdater {
  private timer?: ReturnType<typeof setTimeout>;
  private stopped = false;
  private lastAttempt = 0;
  constructor(
    private directory: Pick<PluginDirectory, "read" | "refresh" | "dispose">,
    private enabled: () => boolean,
    private options: { startupMs?: number; intervalMs?: number; now?: () => number } = {},
  ) {}
  private now() { return this.options.now?.() ?? Date.now(); }
  private interval() { return this.options.intervalMs ?? 6 * 60 * 60 * 1000; }
  start() {
    if (!this.stopped && !this.timer) this.schedule(this.options.startupMs ?? 30_000);
  }
  private schedule(ms: number) {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().catch(() => {}).finally(() => this.schedule(this.interval()));
    }, ms);
    this.timer.unref?.();
  }
  async tick() {
    if (this.stopped || !this.enabled()) return;
    if (this.lastAttempt && this.now() - this.lastAttempt < this.interval()) return;
    const snapshot = await this.directory.read();
    if (this.stopped || !this.enabled()) return;
    if (this.now() - snapshot.fetchedAt < this.interval()) return;
    this.lastAttempt = this.now();
    await this.directory.refresh();
  }
  async dispose() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.directory.dispose();
  }
}
