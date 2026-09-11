import { useEffect, useRef, useState } from "react";
import type { AppState, DesktopAPI, Result } from "../shared/contracts";
import type { CoreCatalogSnapshot } from "../shared/core-catalog";
import { CorePluginPanel, type PluginSelection } from "./CorePluginPanel";
import { CatalogIcon } from "./CatalogIcon";
import { useI18n } from "./i18n";
import { messages } from "./locales/catalog";
const value = <T,>(r: Result<T>): T => {
  if (!r.ok) throw Error(r.error.message);
  return r.value;
};

export function CoreCatalog({
  api,
  state,
  busy,
  kind,
  requestedPlugin,
}: {
  api: DesktopAPI;
  state: AppState;
  busy: boolean;
  kind: "plugins" | "apps";
  requestedPlugin?: { name: string; serial: number };
}) {
  const { t, locale, number } = useI18n(messages);
  const providers = state.integrations.filter(
    (p) => p.kind === "provider" && p.enabled,
  );
  const [provider, setProvider] = useState(
    state.engine.providerId ?? providers[0]?.id ?? "",
  );
  const [workspace, setWorkspace] = useState(state.workspaces[0]?.id ?? "");
  const [remote, setRemote] = useState(false),
    [pending, setPending] = useState(false);
  const [flow, setFlow] = useState<CoreCatalogSnapshot | null>(null),
    [error, setError] = useState<string | { key: string }>("");
  const [ready, setReady] = useState(false);
  const autoReadKey = useRef("");
  const inspectedRequest = useRef("");
  const [refresh, setRefresh] = useState(0),
    [query, setQuery] = useState("");
  const [shown, setShown] = useState(24);
  const [pluginRequest, setPluginRequest] = useState<PluginSelection | null>(
      null,
    ),
    [pluginBusy, setPluginBusy] = useState(false);
  const mounted = useRef(true),
    restored = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let stopped = false,
      timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const current = value(await api.coreCatalogStatus());
        if (stopped) return;
        setFlow(current);
        if (current && (current.busy || !restored.current)) {
          setProvider(current.providerId);
          setWorkspace(current.workspaceId);
          setRemote(current.remote);
        }
        restored.current = true;
        setReady(true);
        if (current?.busy || pending) timer = setTimeout(read, 500);
      } catch (e) {
        if (!stopped)
          setError(
            e instanceof Error ? e.message : { key: "Could not read catalog status" },
          );
      }
    };
    void read();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [api, refresh, pending]);
  const run = async (action: () => Promise<CoreCatalogSnapshot | null>) => {
    setPending(true);
    setError("");
    setRefresh((n) => n + 1);
    try {
      const result = await action();
      if (!mounted.current) return;
      setFlow(result);
      setShown(24);
    } catch (e) {
      if (mounted.current)
        setError(e instanceof Error ? e.message : { key: "Catalog operation failed" });
    } finally {
      if (mounted.current) {
        setPending(false);
        setRefresh((n) => n + 1);
      }
    }
  };
  const selected =
    flow?.providerId === provider &&
    flow.workspaceId === workspace &&
    flow.remote === remote
      ? flow
      : null;
  useEffect(() => {
    if (
      !ready ||
      busy ||
      pending ||
      flow?.busy ||
      pluginBusy ||
      !providers.some((p) => p.id === provider) ||
      !state.workspaces.some((w) => w.id === workspace)
    )
      return;
    const key = JSON.stringify([provider, workspace, remote]);
    if (autoReadKey.current === key) return;
    autoReadKey.current = key;
    if (!selected)
      void run(async () =>
        value(await api.coreCatalogRead(provider, workspace, remote)),
      );
  }, [
    ready,
    busy,
    pending,
    flow?.busy,
    pluginBusy,
    provider,
    workspace,
    remote,
    selected,
    api,
  ]);
  const plugins = selected?.plugins?.marketplaces
    .flatMap((marketplace) =>
      marketplace.plugins.map((plugin) => ({ marketplace, plugin })),
    )
    .sort((a, b) =>
      (a.plugin.interface?.displayName ?? a.plugin.name).localeCompare(
        b.plugin.interface?.displayName ?? b.plugin.name,
      ),
    );
  useEffect(() => {
    if (!requestedPlugin || !selected?.plugins || selected.busy || selected.cancelled || pending || pluginBusy) return;
    const key = `${requestedPlugin.serial}:${selected.id}`;
    if (inspectedRequest.current === key) return;
    const matches = plugins?.filter(({ plugin }) => plugin.name === requestedPlugin.name) ?? [];
    // The public directory never invents an install target. Only exact identities
    // in the freshly selected Core account/workspace catalog may be inspected.
    if (matches.length !== 1) return;
    inspectedRequest.current = key;
    setPluginRequest({ catalogId: selected.id, marketplace: matches[0].marketplace.name,
      pluginId: matches[0].plugin.id, serial: requestedPlugin.serial });
  }, [requestedPlugin, selected, pending, pluginBusy]);
  const installedById = new Map(
    selected?.installedApps?.apps.map((app) => [app.id, app]),
  );
  const appsById = new Map(selected?.apps?.data.map((app) => [app.id, app]));
  const connectors =
    selected?.apps || selected?.installedApps
      ? [...new Set([...appsById.keys(), ...installedById.keys()])]
          .map((id) => ({
            id,
            app: appsById.get(id),
            runtime: installedById.get(id),
          }))
          .filter(({ id, app, runtime }) =>
            `${id} ${app?.name ?? ""} ${runtime?.runtimeName ?? ""}`
              .toLowerCase()
              .includes(query.toLowerCase()),
          )
      : undefined;
  const records =
    kind === "plugins"
      ? plugins?.filter(({ plugin, marketplace }) =>
          `${plugin.name} ${plugin.interface?.displayName ?? ""} ${marketplace.name}`
            .toLowerCase()
            .includes(query.toLowerCase()),
        )
      : connectors;
  return (
    <section
      className="card core-catalog"
      aria-label={
        kind === "plugins"
          ? t("Original Core plugin catalog")
          : t("Original Core connector catalog")
      }
    >
      <h2>
        {kind === "plugins"
          ? t("Original Core plugins")
          : t("Original Core connectors")}
      </h2>
      <p>
        {t("Browse plugins and their original icons before connecting an account. Installation and account connection are separate. Your selected model does not need to be online to browse this directory.")}
      </p>
      {kind === "plugins" && (
        <p className="muted">
          {t("Plugins with “Connection required” stay visible. Review a plugin to see its tools and account requirements; access is never granted automatically.")}
        </p>
      )}
      <fieldset
        className="catalog-controls"
        disabled={busy || pending || !!flow?.busy || pluginBusy}
      >
        <label>
          {t("Catalog provider")}
          <select
            aria-label={t("Catalog provider")}
            value={provider}
            onChange={(e) => setProvider(e.target.value)}
          >
            <option value="">{t("Select an enabled provider")}</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          {t("Catalog workspace")}
          <select
            aria-label={t("Catalog workspace")}
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
          >
            <option value="">{t("Select a workspace")}</option>
            {state.workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        <label className="catalog-checkbox">
          <input
            type="checkbox"
            checked={remote}
            onChange={(e) => setRemote(e.target.checked)}
          />
          {t("Include account-backed remote plugin catalog")}
        </label>
        <p className="muted">
          {t("Remote catalogs may require a signed-in Synora account and organization access. This does not open a sign-in page, install anything or grant permissions.")}
        </p>
        <button
          disabled={
            !providers.some((p) => p.id === provider) ||
            !state.workspaces.some((w) => w.id === workspace)
          }
          onClick={() =>
            void run(async () =>
              value(await api.coreCatalogRead(provider, workspace, remote)),
            )
          }
        >
          {t("Read Core catalog")}
        </button>
      </fieldset>
      {(pending || (flow?.busy && !flow.cleanupFailed)) && (
        <p role="status">
          {flow?.cancelled
            ? t("Cancelling and closing the owned catalog process…")
            : t("Reading Core metadata…")}
        </p>
      )}
      {flow?.busy && !flow.cleanupFailed && (
        <button
          disabled={flow.cancelled}
          onClick={() =>
            void run(async () => value(await api.coreCatalogCancel(flow.id)))
          }
        >
          {t("Cancel catalog read")}
        </button>
      )}
      {error && <p role="alert">{typeof error === "string" ? t("Error: {detail}", { detail: error }) : t(error.key)}</p>}
      {(!provider || !workspace) && (
        <p role="status">
          {t("Choose a provider profile and workspace to browse the directory. No model request is needed.")}
        </p>
      )}
      {selected && (
        <>
          <p className="muted">
            {t("Provider configuration snapshot · {account} · {time}. Not the active conversation's mounted-tool inventory.", {
              account: selected.accountMode === undefined
                ? t("Account status unavailable")
                : (selected.accountMode ?? t("No signed-in account")),
              time: new Date(selected.completedAt ?? selected.startedAt).toLocaleTimeString(locale === "pt" ? "pt-PT" : locale),
            })}
          </p>
          {selected.cancelled && (
            <p role="status">
              {t("Catalog read cancelled. No installation or inference was started.")}
            </p>
          )}
          {selected.errors.map((e, n) => (
            <p role="alert" key={n}>
              {e.method} · {e.code}: {e.message}
            </p>
          ))}
          {selected.plugins?.marketplaceLoadErrors.map((e, n) => (
            <pre key={n} role="alert" className="muted">
              {JSON.stringify(e, null, 2)}
            </pre>
          ))}
          {!!selected.identityConflicts?.length && (
            <section className="catalog-identity-conflicts" role="status" aria-label={t("Catalog identity conflicts")}>
              <p>{t("Some catalog identities conflict. Unaffected entries remain available; no action is allowed on the conflicting entries.")}</p>
              <details>
                <summary>{t("Unavailable identities: {count}", { count: number(selected.identityConflicts.length) })}</summary>
                <ul>{selected.identityConflicts.map(c => (
                  <li key={JSON.stringify([c.kind, c.marketplace, c.id])}>
                    <code>{c.id}</code>{c.marketplace ? ` · ${c.marketplace}` : ""} · {t("{count} conflicting records", { count: number(c.occurrences) })}
                  </li>
                ))}</ul>
              </details>
            </section>
          )}
          <label>
            {t("Filter Core catalog")}
            <input
              aria-label={t("Filter Core catalog")}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShown(24);
              }}
            />
          </label>
          {records && (
            <p>
              {kind === "plugins"
                ? t("{count} plugins reported by Core", { count: number(records.length) })
                : t("{count} connectors reported by Core", { count: number(records.length) })}
              {!records.length && t(". Check account access, feature availability and marketplace configuration if entries are expected.")}
            </p>
          )}
          {kind === "plugins" &&
            plugins
              ?.filter(({ plugin, marketplace }) =>
                `${plugin.name} ${plugin.interface?.displayName ?? ""} ${marketplace.name}`
                  .toLowerCase()
                  .includes(query.toLowerCase()),
              )
              .slice(0, shown)
              .map(({ plugin, marketplace }) => (
                <article
                  className="card"
                  key={JSON.stringify([marketplace.name, plugin.id])}
                >
                  <div className="catalog-card-heading">
                    <CatalogIcon
                      key={selected.id}
                      api={api}
                      available={
                        !pending && !selected.busy && !selected.cancelled
                      }
                      identity={{
                        catalogId: selected.id,
                        kind: "plugin",
                        marketplace: marketplace.name,
                        id: plugin.id,
                      }}
                      name={plugin.interface?.displayName ?? plugin.name}
                    />
                    <h3>{plugin.interface?.displayName ?? plugin.name}</h3>
                  </div>
                  <p>
                    {plugin.interface?.shortDescription ??
                      plugin.interface?.longDescription}
                  </p>
                  <p>
                    {plugin.installed ? t("Installed") : t("Not installed")} ·{" "}
                    {plugin.enabled ? t("Enabled") : t("Disabled")} ·{" "}
                    {plugin.availability}
                  </p>
                  {selected.discoveryOnlyPluginIds?.includes(plugin.id) && (
                    <p className="catalog-connection-required">
                      {t("Connection required · Public directory entry. Connect the required account to make its tools available; it is not yet callable in this profile.")}
                    </p>
                  )}
                  <p className="mono">
                    {plugin.id} · {marketplace.name}
                  </p>
                  <p>
                    {t("Local version: {local} · Catalog version: {catalog}", {
                      local: plugin.localVersion ?? t("Not reported"),
                      catalog: plugin.version ?? t("Not reported"),
                    })}
                  </p>
                  {plugin.disabledReason && (
                    <p>{JSON.stringify(plugin.disabledReason)}</p>
                  )}
                  <button
                    disabled={busy || pending || !!flow?.busy || pluginBusy}
                    onClick={() =>
                      setPluginRequest({
                        catalogId: selected.id,
                        marketplace: marketplace.name,
                        pluginId: plugin.id,
                        serial: (pluginRequest?.serial ?? 0) + 1,
                      })
                    }
                  >
                    {t("Inspect plugin capabilities")}
                  </button>
                  <details>
                    <summary>{t("Original plugin metadata")}</summary>
                    <pre>{JSON.stringify(plugin, null, 2)}</pre>
                  </details>
                </article>
              ))}
          {kind === "apps" &&
            connectors?.slice(0, shown).map(({ id, app, runtime }) => {
              return (
                <article className="card" key={id}>
                  <div className="catalog-card-heading">
                    <CatalogIcon
                      key={selected.id}
                      api={api}
                      available={
                        !pending && !selected.busy && !selected.cancelled
                      }
                      identity={{ catalogId: selected.id, kind: "app", id }}
                      name={app?.name ?? runtime?.runtimeName ?? id}
                    />
                    <h3>{app?.name ?? runtime?.runtimeName ?? id}</h3>
                  </div>
                  <p>{app?.description}</p>
                  <p className="mono">{id}</p>
                  {app ? (
                    <p>
                      {app.isAccessible
                        ? t("Account-accessible")
                        : t("Not account-accessible")}{" "}
                      · {app.isEnabled ? t("Enabled") : t("Disabled")}
                    </p>
                  ) : (
                    <p>
                      {t("Catalog metadata unavailable. This entry was reported by the committed Core runtime.")}
                    </p>
                  )}
                  <p>
                    {t("Committed Core runtime:")}{" "}
                    {runtime
                      ? runtime.callable
                        ? t("Callable in this provider snapshot")
                        : t("Not callable")
                      : t("Not reported")}
                  </p>
                  {runtime && (
                    <p>
                      {t("Runtime configuration:")}{" "}
                      {runtime.enabled ? t("Enabled") : t("Disabled")}
                    </p>
                  )}
                  <details>
                    <summary>{t("Original connector metadata")}</summary>
                    <pre>
                      {JSON.stringify(
                        { catalog: app ?? null, runtime: runtime ?? null },
                        null,
                        2,
                      )}
                    </pre>
                  </details>
                </article>
              );
            })}
          {!!records && records.length > shown && (
            <button onClick={() => setShown((n) => n + 24)}>
              {t("Show more catalog entries")}
            </button>
          )}
        </>
      )}
      {kind === "plugins" && (
        <CorePluginPanel
          api={api}
          request={pluginRequest}
          onBusy={setPluginBusy}
          onChanged={() => setRefresh((n) => n + 1)}
        />
      )}
    </section>
  );
}
