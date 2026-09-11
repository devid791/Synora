import { useEffect, useRef, useState } from "react";
import { ImageOff, Search, RefreshCw, X } from "lucide-react";
import type { AppState, DesktopAPI, Result } from "../shared/contracts";
import type { PluginDirectoryEntry, PluginDirectorySnapshot } from "../shared/plugin-directory";
import seed from "../shared/plugin-directory-seed.json" with { type: "json" };
import { Modal } from "./Modal";
import { CoreCatalog } from "./CoreCatalog";
import { useI18n } from "./i18n";
import { messages } from "./locales/plugin-directory";

const value = <T,>(result: Result<T>): T => {
  if (!result.ok) throw Error(result.error.message);
  return result.value;
};

/** Browsing is local public metadata. Connecting is a separate, explicit flow. */
export function PluginDirectory({ api, state, busy, onState }: {
  api: DesktopAPI; state: AppState; busy: boolean; onState: (state: AppState) => void;
}) {
  const { t, number, locale } = useI18n(messages);
  const [snapshot, setSnapshot] = useState(seed as unknown as PluginDirectorySnapshot);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PluginDirectoryEntry | null>(null);
  const [management, setManagement] = useState<{ name: string; serial: number } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [pending, setPending] = useState(false);
  const [preferencePending, setPreferencePending] = useState(false);
  const [error, setError] = useState("");
  const [brokenIcons, setBrokenIcons] = useState<Set<string>>(new Set());
  const mounted = useRef(true);
  const managementRoot = useRef<HTMLDivElement>(null);
  useEffect(() => {
    mounted.current = true;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const current = value(await api.pluginDirectoryRead(false));
        if (!stopped) setSnapshot(current);
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : t("Catalog unavailable; the local directory is still visible."));
      } finally {
        if (!stopped) timer = setTimeout(read, 60_000);
      }
    };
    void read();
    return () => { mounted.current = false; stopped = true; clearTimeout(timer); };
  }, [api]);
  useEffect(() => {
    if (management) managementRoot.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  }, [management]);
  const refresh = async () => {
    if (pending) return;
    setPending(true); setError("");
    try {
      const current = value(await api.pluginDirectoryRead(true));
      if (mounted.current) setSnapshot(current);
    } catch (e) {
      if (mounted.current) setError(e instanceof Error ? e.message : t("Catalog update failed; keeping the last valid directory."));
    } finally { if (mounted.current) setPending(false); }
  };
  const entries = snapshot.entries.filter(entry =>
    `${entry.displayName} ${entry.name} ${entry.description} ${entry.category}`.toLocaleLowerCase()
      .includes(query.trim().toLocaleLowerCase()));
  return <>
    <section className="plugin-directory" aria-label={t("Plugin library")}>
      <div className="page-title"><div>
        <p className="eyebrow">{t("PLUGIN LIBRARY")}</p>
        <h1>{t("Your tools. Your choice.")}</h1>
        <p>{t("Always visible, even offline or with Axiom alone. You choose what to install and which accounts to connect.")}</p>
      </div></div>
      <article className="card plugin-directory-source">
        <div><strong>OpenAI Plugins</strong><p className="mono">github.com/openai/plugins</p>
          <small>{t("Public repository · Original manifests and icons · No automatic access")}</small></div>
        <div className="plugin-directory-source-actions">
          <label><input type="checkbox" checked={state.preferences.pluginCatalogAutomatic !== false}
            disabled={preferencePending} onChange={e => {
              const pluginCatalogAutomatic = e.currentTarget.checked;
              setPreferencePending(true);
              void api.preferences({ pluginCatalogAutomatic }).then(result => {
                const next = value(result);
                if (mounted.current) onState(next);
              }).catch(e => { if (mounted.current) setError(String(e.message ?? e)); })
                .finally(() => { if (mounted.current) setPreferencePending(false); });
            }} />{t("Automatically update the directory")}</label>
          <button disabled={pending || snapshot.checking} onClick={() => void refresh()}>
            <RefreshCw size={16} />{pending || snapshot.checking ? t("Updating directory…") : t("Refresh directory")}
          </button>
        </div>
        <p className="muted plugin-directory-source-note">{t("Checks every 6 hours while Synora is open. Updates names, versions and icons only; installed code, permissions and account connections are unchanged.")}</p>
        <small className="plugin-directory-source-note">{t("Revision {revision} · Checked {time}", {
          revision: snapshot.revision.slice(0, 12),
          time: new Date(snapshot.fetchedAt).toLocaleString(locale === "pt" ? "pt-PT" : locale),
        })}</small>
      </article>
      {(error || snapshot.error) && <p role="alert">{error || snapshot.error}</p>}
      <div className="plugin-directory-search"><label><Search size={18} />
        <input aria-label={t("Search plugins")} placeholder={t("Search plugins")} value={query}
          onChange={e => setQuery(e.currentTarget.value)} />
      </label><span>{t("{count} plugins", { count: number(entries.length) })}</span></div>
      <p className="muted">{t("Directory entries are not a list of connected tools. Account and workspace access are checked only when you manage a connection.")}</p>
      <div className="plugin-directory-grid">
        {entries.map(entry => <article className="card plugin-directory-card" key={entry.id}>
          <div className="catalog-card-heading">
            {entry.icon && !brokenIcons.has(entry.id) ? <img className="catalog-icon"
              src={entry.icon.dataUrl} alt={t("{name} original icon", { name: entry.displayName })}
              data-icon-sha256={entry.icon.sha256} loading="lazy" decoding="async"
              onError={() => setBrokenIcons(previous => new Set([...previous, entry.id]))} />
              : <span className="catalog-icon" title={t("Original icon unavailable")}><ImageOff /></span>}
            <div><h3>{entry.displayName}</h3><small>{entry.category}</small></div>
          </div>
          <p className="plugin-directory-preview">{entry.description}</p>
          <small>{entry.requiresAccount ? t("Account connection required") : t("Review installation requirements")}</small>
          <button aria-haspopup="dialog" onClick={() => setSelected(entry)}>{t("View plugin")}</button>
        </article>)}
      </div>
      {!entries.length && <p role="status">{t("No plugins match your search.")}</p>}
      <details className="card" open={advanced} onToggle={e => {
        setAdvanced(e.currentTarget.open);
        if (e.currentTarget.open) setManagement(null);
      }}>
        <summary>{t("Manage installed plugins and account catalogs")}</summary>
        <p>{t("This separate view reads the selected profile. Browsing the public library above never changes your active model.")}</p>
        {advanced && <CoreCatalog api={api} state={state} busy={busy} kind="plugins" />}
      </details>
    </section>
    {selected && <Modal label={selected.displayName} onDismiss={() => setSelected(null)}>
      <section className="modal plugin-directory-detail">
        <div className="page-title"><h2>{selected.displayName}</h2>
          <button aria-label={t("Close plugin")} onClick={() => setSelected(null)}><X /></button></div>
        <p className="plugin-directory-description">{selected.description}</p>
        <p>{t("Version {version}", { version: selected.version ?? "—" })}</p>
        <p className="mono">{selected.id}</p>
        {selected.requiresAccount && <p className="notice">{t("This plugin uses an account-backed app connector. Its account entitlement and authorization are separate from Axiom inference; installation alone does not grant access.")}</p>}
        <p>{t("Review first. Nothing is installed, connected or executed by opening this page.")}</p>
        <details><summary>{t("Original source")}</summary><p className="mono">{selected.sourceUrl}</p></details>
        <button onClick={() => {
          setManagement({ name: selected.name, serial: Date.now() });
          setSelected(null); setAdvanced(false);
        }}>{t("Manage connection")}</button>
      </section>
    </Modal>}
    {management && <div ref={managementRoot} className="plugin-directory-management">
      <div className="page-title"><h2>{t("Connection setup: {name}", { name: management.name })}</h2>
        <button aria-label={t("Close connection setup")} onClick={() => setManagement(null)}><X /></button></div>
      <p>{t("Choose the profile and workspace that will use this plugin. Your active model is not changed. Installation and sign-in each require your decision.")}</p>
      <CoreCatalog api={api} state={state} busy={busy} kind="plugins" requestedPlugin={management} />
    </div>}
  </>;
}
