import type { AgencyCatalog } from "./agency-catalog";
import type { AgencyCatalogSnapshot } from "../shared/agency-catalog";
import type { BotCatalogUpdateStatus } from "../shared/contracts";
import { manifestHash, type Store } from "./store";

/** Catalog data only. Never starts a model, installs executable code, or edits a session. */
export class BotCatalogUpdater {
  private timer?: ReturnType<typeof setTimeout>;
  private running?: Promise<AgencyCatalogSnapshot | null>;
  private disposed = false;
  private state: BotCatalogUpdateStatus = {
    checking: false,
    lastCheckedAt: null,
    lastSuccessAt: null,
    updated: 0,
    error: null,
  };
  constructor(
    private catalog: Pick<
      AgencyCatalog,
      "read" | "preview" | "consumePreview" | "dispose"
    >,
    private store: Store,
    private notify: () => void,
    private options: {
      intervalMs?: number;
      startupMs?: number;
      now?: () => number;
    } = {},
  ) {}
  status() {
    return { ...this.state };
  }
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private interval() {
    return this.options.intervalMs ?? 6 * 60 * 60 * 1000;
  }
  private enabled() {
    return (
      !this.disposed &&
      this.store.read().preferences.botCatalogAutomatic !== false
    );
  }
  start() {
    if (!this.disposed && !this.timer)
      this.schedule(this.options.startupMs ?? 30_000);
  }
  private schedule(delay: number) {
    if (this.disposed) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick().finally(() => this.schedule(this.interval()));
    }, delay);
    this.timer.unref?.();
  }
  async tick() {
    if (!this.enabled()) return;
    let cached: AgencyCatalogSnapshot | null = null;
    try {
      cached = await this.catalog.read(false);
    } catch {
      /* recover cache from pinned source */
    }
    if (cached && this.now() - cached.fetchedAt < this.interval()) return;
    try {
      await this.refresh();
    } catch {
      /* status remains visible; retry at next interval, no retry storm */
    }
  }
  refresh(): Promise<AgencyCatalogSnapshot | null> {
    if (this.disposed) return Promise.reject(Error("Bot catalog is closed"));
    if (this.running) return this.running;
    this.running = this.run().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private async run() {
    this.state = {
      ...this.state,
      checking: true,
      lastCheckedAt: this.now(),
      updated: 0,
      error: null,
    };
    this.notify();
    const errors: string[] = [];
    try {
      const snapshot = await this.catalog.read(true);
      if (!snapshot || this.disposed) return snapshot;
      if (this.enabled()) {
        for (const saved of this.store.read().presets) {
          if (!this.enabled()) break;
          const source = saved.source;
          if (!source?.managed || source.baseHash !== manifestHash(saved))
            continue;
          const entry = snapshot.entries.find((e) => e.path === source.path);
          if (!entry) {
            errors.push(
              `${saved.name}: source no longer available; retained last valid version`,
            );
            continue;
          }
          if (entry.blobSha === source.blobSha) continue;
          try {
            const preview = await this.catalog.preview(
              entry.id,
              snapshot.revision,
            );
            if (!this.enabled()) break;
            const verified = this.catalog.consumePreview(preview.id, true);
            if (this.store.updateAgency(saved.id, source.baseHash, verified))
              this.state.updated++;
          } catch {
            errors.push(
              `${saved.name}: update could not be validated; retained last valid version`,
            );
          }
        }
      }
      this.state.lastSuccessAt = errors.length
        ? this.state.lastSuccessAt
        : this.now();
      this.state.error = errors.length ? errors.slice(0, 8).join("\n") : null;
      return snapshot;
    } catch (error) {
      this.state.error =
        "Catalog refresh failed. Previously saved bots remain available; retry Refresh.";
      throw error;
    } finally {
      this.state.checking = false;
      if (!this.disposed) this.notify();
    }
  }
  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.catalog.dispose();
    await this.running?.catch(() => {});
  }
}
