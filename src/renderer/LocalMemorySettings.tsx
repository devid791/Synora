import { useEffect, useState } from "react";
import type { AppState, DesktopAPI, LocalMetrics } from "../shared/contracts";
import type { LocalMemoryProfile } from "../shared/local-memory";
import { useI18n } from "./i18n";
import { messages } from "./locales/composer";
export function LocalMemorySettings({ api, state, updated }: {
  api: DesktopAPI; state: AppState; updated: (state: AppState) => void;
}) {
  const { t, number } = useI18n(messages);
  const mib = (n: number) => `${number(Math.round(n / 1024 ** 2))} MiB`;
  const [metrics, setMetrics] = useState<LocalMetrics>(), [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let live = true, pending = false;
    const read = async () => {
      if (pending || document.hidden) return;
      pending = true;
      try { const r = await api.metrics(); if (live && r.ok) setMetrics(r.value); }
      finally { pending = false; }
    };
    void read().catch(() => {}); const timer = window.setInterval(() => void read().catch(() => {}), 2000);
    return () => { live = false; window.clearInterval(timer); };
  }, [api]);
  const data = metrics?.localMemory;
  return <article className="card settings-card" aria-label={t("Local session memory")}>
    <label><span><strong>{t("Local session memory")}</strong>
      <small>{t("Conversation history and bot records are saved by this Synora host, independently of Axiom’s inference KV cache.")}</small></span>
      <select aria-label={t("Local history cache")} value={state.preferences.localMemory ?? "balanced"} disabled={saving}
        onChange={async e => {
          const localMemory = e.target.value as LocalMemoryProfile;
          setSaving(true); setError("");
          try { const r = await api.preferences({ localMemory }); if (!r.ok) throw Error(r.error.message);
            updated(r.value); const m = await api.metrics(); if (m.ok) setMetrics(m.value);
          } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
          finally { setSaving(false); }
        }}>
        <option value="lean">{t("Lean")}</option><option value="balanced">{t("Balanced")}</option><option value="expanded">{t("Expanded")}</option>
      </select>
    </label>
    {data ? <>
      <p>{t("Local history cache target: {cache} · App service RAM: {ram}", { cache: mib(data.cacheTargetBytes), ram: mib(metrics!.rssBytes) })}</p>
      <p>{t("Host RAM: {ram} · JavaScript heap: {used} / {limit}", { ram: mib(data.physicalMemoryBytes), used: mib(data.heapUsedBytes), limit: mib(data.heapLimitBytes) })}</p>
      <p className="mono local-storage-path">{data.storageDirectory}</p>
    </> : <p>{t("Reading this Synora host’s memory and storage location…")}</p>}
    <small>{t("The selector controls the local SQLite history cache, allocated on demand. It does not reserve RAM, resize Core’s working memory or guarantee a number of warm agents. Prompts and required tool results still go to the selected model. In web mode, “host” means the Synora service machine, not the browser device.")}</small>
    {error && <p role="alert">{error}</p>}
  </article>;
}
