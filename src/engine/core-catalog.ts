import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { AppServerTransport, AppServerError } from "./app-server-transport";
import { parseResponse } from "./protocol-validation";
import type { prepareAxiomProcess } from "./axiom-process";
import type { CoreCatalogSnapshot } from "../shared/core-catalog";
import { supplementPublicCatalog, publicCatalogPrecedence } from "../shared/core-catalog";
import type { AppsListResponse } from "../protocol/codex-0.153.4/v2/AppsListResponse";
import { CatalogIdentityIndex, normalizePluginIdentities } from "./catalog-identities";
type Prepared = Awaited<ReturnType<typeof prepareAxiomProcess>>;
type Wire = Pick<
  AppServerTransport,
  "request" | "notify" | "respond" | "close"
>;
class CatalogError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Owns one explicit, metadata-only Core connection; never starts a model turn. */
export class CoreCatalogReader {
  private current: CoreCatalogSnapshot | null = null;
  private operation?: Promise<CoreCatalogSnapshot>;
  private transport?: Wire;
  constructor(
    private create: (
      options: ConstructorParameters<typeof AppServerTransport>[0],
    ) => Wire = (o) => new AppServerTransport(o),
    private deadlineMs = 60000,
  ) {}
  get busy() {
    return !!this.operation || !!this.current?.cleanupFailed;
  }
  snapshot() {
    return structuredClone(this.current);
  }
  invalidate() {
    if (this.busy) throw Error("Cannot invalidate an active catalog read");
    this.current = null;
  }
  pluginTarget(catalogId: string, marketplaceName: string, pluginId: string) {
    const s = this.current;
    if (this.busy || !s || s.id !== catalogId || s.cancelled || !s.plugins)
      throw Error("Read the current catalog before selecting a plugin");
    if (s.identityConflicts?.some(c => c.kind === "plugin" && c.marketplace === marketplaceName && c.id === pluginId))
      throw Error("Plugin identity is ambiguous in the current catalog; no action is allowed");
    const matches = s.plugins.marketplaces
      .filter((m) => m.name === marketplaceName)
      .flatMap((m) =>
        m.plugins
          .filter((p) => p.id === pluginId)
          .map((p) => ({ marketplace: m, plugin: p })),
      );
    if (matches.length !== 1)
      throw Error(
        "Plugin identity is missing or ambiguous in the current catalog",
      );
    const { marketplace, plugin } = matches[0];
    return {
      catalogId,
      providerId: s.providerId,
      workspaceId: s.workspaceId,
      marketplaceName,
      marketplacePath: marketplace.path,
      pluginId,
      pluginName: plugin.name,
      remotePluginId: plugin.remotePluginId,
      discoveryOnly: s.discoveryOnlyPluginIds?.includes(plugin.id) ?? false,
    };
  }
  read(
    identity: Pick<
      CoreCatalogSnapshot,
      "providerId" | "workspaceId" | "remote"
    >,
    prepare: () => Promise<Prepared>,
  ): Promise<CoreCatalogSnapshot> {
    if (this.busy)
      throw Error(
        "Wait for the existing catalog operation and owned cleanup to finish",
      );
    this.current = {
      ...identity,
      id: randomUUID(),
      scope: "provider-configuration",
      startedAt: Date.now(),
      busy: true,
      cancelled: false,
      plugins: null,
      apps: null,
      installedApps: null,
      identityConflicts: [],
      identicalDuplicates: { plugins: 0, apps: 0 },
      errors: [],
    };
    const state = this.current;
    const pending = this.run(state, prepare).finally(() => {
      if (this.operation === pending) this.operation = undefined;
    });
    this.operation = pending;
    return pending;
  }
  private async run(
    state: CoreCatalogSnapshot,
    prepare: () => Promise<Prepared>,
  ) {
    let prepared: Prepared | undefined;
    let accountIdentities: CoreCatalogSnapshot["plugins"] = null;
    const end = Date.now() + this.deadlineMs;
    const request = async (method: string, params: unknown) => {
      if (state.cancelled) throw Error("Catalog cancelled");
      const remaining = end - Date.now();
      if (remaining <= 0)
        throw new AppServerError(
          "CATALOG_DEADLINE",
          "Catalog deadline exceeded",
        );
      return this.transport!.request(
        method,
        params,
        Math.min(30000, remaining),
      );
    };
    const record = (method: string, error: unknown) => {
      if (state.cancelled) return;
      state.errors.push({
        method,
        code:
          error instanceof AppServerError || error instanceof CatalogError
            ? String(error.code)
            : "CATALOG_INVALID_RESPONSE",
        message:
          error instanceof CatalogError
            ? error.message
            : error instanceof Error &&
                error.message.startsWith("Invalid App Server ")
              ? error.message
              : "Core could not read this catalog. Check the selected account, marketplace configuration and connectivity, then retry.",
      });
    };
    try {
      prepared = await prepare();
      if (state.cancelled) throw Error("Catalog cancelled during preparation");
      const cwd = prepared.cwd;
      // Original Core owns and synchronizes this public marketplace. Listing it
      // adds browse-only metadata, not grants, installation or inference tools.
      const publicRoot = prepared.env?.CODEX_HOME
        ? join(prepared.env.CODEX_HOME, ".tmp", "plugins")
        : undefined;
      const transport = this.create({
        ...prepared,
        onNotification: () => {},
        onRequest: (r) =>
          transport.respond(r.id, {
            error: {
              code: -32601,
              message:
                "Catalog connection cannot execute tools or approve actions",
            },
          }),
        onClose: () => {},
      });
      this.transport = transport;
      // The owned transport now owns prepared.cleanup exactly once.
      prepared = undefined;
      await request("initialize", {
        clientInfo: { name: "synora_harness_desktop", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      });
      transport.notify("initialized");
      try {
        const account = parseResponse(
          "account",
          await request("account/read", { refreshToken: false }),
        );
        state.accountMode = account.account?.type ?? null;
      } catch (e) {
        record("account/read", e);
      }
      try {
        accountIdentities = parseResponse(
          "plugins",
          await request("plugin/list", {
            cwds: [cwd],
            ...(state.remote ? {} : { marketplaceKinds: ["local"] }),
            forceRefetch: false,
          }),
        );
        const normalized = normalizePluginIdentities(accountIdentities);
        state.plugins = normalized.plugins;
        state.identityConflicts!.push(...normalized.conflicts);
        state.identicalDuplicates!.plugins = normalized.identicalDuplicates;
      } catch (e) {
        record("plugin/list", e);
      }
      if (state.plugins && publicRoot) {
        try {
          const exists = await stat(
            join(publicRoot, ".agents/plugins/marketplace.json"),
          )
            .then((s) => s.isFile())
            .catch((e: NodeJS.ErrnoException) => {
              if (e.code === "ENOENT") return false;
              throw e;
            });
          if (exists) {
            const publicCatalog = parseResponse(
              "plugins",
              await request("plugin/list", {
                cwds: [cwd, publicRoot],
                marketplaceKinds: ["local"],
                forceRefetch: false,
              }),
            );
            // Normalize supplemental entries too; never resurrect a blocked account
            // identity via a fallback catalog. Conflicts are still visible separately.
            const publicNormalized = normalizePluginIdentities(publicCatalog);
            const precedence = publicCatalogPrecedence(accountIdentities ?? state.plugins);
            state.identityConflicts!.push(...publicNormalized.conflicts.filter(c =>
              c.marketplace === "openai-curated" &&
              !precedence.ids.has(c.id) &&
              !publicCatalog.marketplaces.some(m => m.name === c.marketplace && m.plugins.some(p => p.id === c.id && precedence.curatedNames.has(p.name))) &&
              !state.identityConflicts!.some(old => old.kind === c.kind && old.marketplace === c.marketplace && old.id === c.id)));
            const supplemented = supplementPublicCatalog(state.plugins, publicNormalized.plugins, accountIdentities ?? state.plugins);
            for (const m of supplemented.plugins.marketplaces) m.plugins = m.plugins.filter(p =>
              !state.identityConflicts!.some(c => c.kind === "plugin" && c.marketplace === m.name && c.id === p.id));
            Object.assign(state, supplemented);
            if (publicCatalog.marketplaceLoadErrors.length)
              throw new CatalogError(
                "PUBLIC_CATALOG_PARTIAL",
                "Core could not read part of the public marketplace. Refresh to retry; connected tools are unchanged.",
              );
          }
        } catch (e) {
          record("plugin/list/public", e);
        }
      }
      try {
        const identities = new CatalogIdentityIndex<AppsListResponse["data"][number]>();
        const cursors = new Set<string>();
        let cursor: string | null = null;
        do {
          const page: AppsListResponse = parseResponse(
            "apps",
            await request("app/list", {
              cursor,
              limit: 100,
              forceRefetch: false,
            }),
          );
          for (const app of page.data) identities.add(app.id, app);
          // JSON schema permits an omitted terminal Option, despite the generated TS type.
          cursor = page.nextCursor ?? null;
          if (cursor !== null) {
            if (cursors.has(cursor))
              throw new CatalogError(
                "CATALOG_CURSOR_LOOP",
                "Core repeated a connector pagination cursor. The incomplete list is not advertised; retry the catalog read.",
              );
            cursors.add(cursor);
          }
        } while (cursor !== null);
        const normalized = identities.result();
        state.apps = { data: normalized.values, nextCursor: null };
        state.identityConflicts!.push(...normalized.conflicts.map(c => ({ kind: "app" as const, id: c.key, occurrences: c.occurrences })));
        state.identicalDuplicates!.apps = normalized.identicalDuplicates;
      } catch (e) {
        record("app/list", e);
      }
      try {
        state.installedApps = parseResponse(
          "installedApps",
          await request("app/installed", { forceRefresh: false }),
        );
        const ids = state.installedApps.apps.map((app) => app.id);
        if (new Set(ids).size !== ids.length) {
          state.installedApps = null;
          throw new CatalogError(
            "CATALOG_DUPLICATE_INSTALLED_APP",
            "Core returned duplicate installed connector IDs. Runtime availability is unknown.",
          );
        }
      } catch (e) {
        record("app/installed", e);
      }
    } catch (e) {
      record("initialize/account", e);
    } finally {
      try {
        await this.transport?.close();
        await prepared?.cleanup?.();
      } catch {
        state.cleanupFailed = true;
        state.errors.push({
          method: "cleanup",
          code: "CATALOG_CLEANUP_FAILED",
          message:
            "Owned catalog cleanup failed. Restart Synora before another catalog operation.",
        });
      }
      this.transport = undefined;
      state.busy = !!state.cleanupFailed;
      state.completedAt = Date.now();
    }
    return structuredClone(state);
  }
  async cancel(id: string) {
    if (!this.current || this.current.id !== id)
      throw Error("Catalog operation identity does not match");
    if (!this.operation) return this.snapshot();
    this.current.cancelled = true;
    try {
      await this.transport?.close();
    } catch {
      /* run() owns the cleanup result */
    }
    await this.operation;
    return this.snapshot();
  }
  async dispose() {
    if (this.current && this.operation) await this.cancel(this.current.id);
  }
}
