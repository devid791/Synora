import { useEffect, useRef, useState } from "react";
import { Bot, Code2, Search, ShieldCheck, Bug, FlaskConical, BookOpen, FileText, Globe, Network, Clock, Zap, Plus, X, type LucideIcon } from "lucide-react";
import type { AppState, BotCatalogUpdateStatus, DesktopAPI, Preset, Result } from "../shared/contracts";
import { botTemplates, templatePresetId } from "../shared/bot-library";
import type { AgencyCatalogSnapshot, AgencyPreview } from "../shared/agency-catalog";
import { Modal } from "./Modal";
import { useI18n } from "./i18n";
import { messages, templateLabels } from "./locales/bots";

type Template = (typeof botTemplates)[number];
type EditablePreset = Omit<Preset, "id"> & { id?: string };
export type BotSelection = { templateId: string } | { presetId: string | null };
const unwrap = <T,>(result: Result<T>): T => {
  if (!result.ok) throw Error(result.error.message);
  return result.value;
};
const freshPreset: EditablePreset = {
  schema: "synora.bot.v1", name: "", description: "", instructions: "",
  kind: "coding", profile: "medium", context: 262144, connectorIds: [], enabled: true,
};
const icons: Record<string, LucideIcon> = {
  coding: Code2, review: ShieldCheck, debug: Bug, testing: FlaskConical,
  research: BookOpen, docs: FileText, browser: Globe, supervisor: Network,
  scheduled: Clock, event: Zap,
};
const kinds = { coding: "Coding", research: "Research", scheduled: "Scheduled · manual", event: "Event · manual", browser: "Browser", supervisor: "Supervisor" } as const;
const templateFor = (preset: Preset) => botTemplates.find((entry) => templatePresetId(entry.id) === preset.id);

/** Names/descriptions here are UI copy only. Installation always uses the host's canonical template. */
export function BotLibrary({ api, state, active, useLocked, acceptState, onUse }: {
  api: DesktopAPI; state: AppState; active: boolean; useLocked: boolean;
  acceptState: (state: AppState) => void; onUse: (selection: BotSelection) => Promise<void>;
}) {
  const { t, locale } = useI18n(messages);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [source, setSource] = useState("all");
  const [editor, setEditor] = useState<EditablePreset | null>(null);
  const [preview, setPreview] = useState<Template | Preset | null>(null);
  const [deleting, setDeleting] = useState<Preset | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [catalog, setCatalog] = useState<AgencyCatalogSnapshot | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<BotCatalogUpdateStatus | null>(null);
  const [agencyPreview, setAgencyPreview] = useState<AgencyPreview | null>(null);
  const [reviewed, setReviewed] = useState(false);
  const catalogRequest = useRef(0);
  const acceptCatalog = (next: AgencyCatalogSnapshot | null) => {
    setCatalog((previous) => next && (!previous || next.fetchedAt >= previous.fetchedAt) ? next : previous);
    setCatalogLoaded(true);
  };
  useEffect(() => {
    if (!active) return;
    const readCached = () => {
      const request = ++catalogRequest.current;
      // Cache/status only on initial mount and resync. Automatic network work belongs to the host.
      void Promise.all([api.botCatalogRead(false).then(unwrap), api.botCatalogUpdates().then(unwrap)]).then(([next, status]) => {
        if (request !== catalogRequest.current) return;
        acceptCatalog(next); setUpdateStatus(status); setCatalogError(status.error ?? "");
      }).catch((e) => { if (request === catalogRequest.current) { setCatalogLoaded(true); setCatalogError(e instanceof Error ? e.message : String(e)); } });
    };
    readCached();
    const off = api.onEvent((event) => { if (event.kind === "resync") readCached(); });
    return () => { catalogRequest.current++; off(); };
  }, [active, api]);
  // Keep this component mounted when navigating: admission must not reset mid-write.
  const perform = async (operation: () => Promise<void>) => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(true); setError(""); setNotice("");
    try { await operation(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { pendingRef.current = false; setPending(false); }
  };
  const dismiss = () => {
    if (pendingRef.current) return;
    setEditor(null); setPreview(null); setDeleting(null); setAgencyPreview(null); setError("");
  };
  const labelFor = (entry: Template) => templateLabels[entry.id as keyof typeof templateLabels];
  const templateName = (entry: Template) => t(labelFor(entry)?.name ?? entry.name);
  const templateDescription = (entry: Template) => t(labelFor(entry)?.description ?? entry.description);
  const uniqueName = (name: string) => {
    const used = new Set(state.presets.map((p) => p.name.trim().toLocaleLowerCase()));
    let candidate = name.slice(0, 80), n = 2;
    while (used.has(candidate.trim().toLocaleLowerCase())) {
      const suffix = ` (${n++})`;
      candidate = name.slice(0, 80 - suffix.length) + suffix;
    }
    return candidate;
  };
  const edit = (preset?: Preset, duplicate = false) => {
    setError(""); setNotice("");
    if (!preset) { setEditor({ ...freshPreset, connectorIds: [] }); return; }
    const { id, source: origin, ...value } = preset;
    const fork = duplicate || origin?.managed;
    setEditor(fork ? { ...value, source: origin ? { ...origin, managed: false } : undefined, connectorIds: [...value.connectorIds], name: uniqueName(t("{name} copy", { name: value.name })) } : { ...value, source: origin, id });
  };
  const customize = (entry: Template) => {
    setError(""); setNotice("");
    setEditor({ ...freshPreset, name: uniqueName(templateName(entry)), description: templateDescription(entry), instructions: entry.instructions, kind: entry.kind, connectorIds: [] });
  };
  const install = async (entry: Template) => {
    const result = unwrap(await api.presetInstallTemplate(entry.id));
    acceptState(result.state);
    setNotice(t("Added to My bots."));
  };
  const use = (selection: BotSelection) => { if (!useLocked) void perform(() => onUse(selection)); };
  const matches = (name: string, description: string, cat: string, kind: string) =>
    (category === "all" || category === cat || category === kind) &&
    `${name} ${description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const templates = source === "all" || source === "built-in" ? botTemplates.filter((entry) => matches(templateName(entry), templateDescription(entry), entry.id, entry.kind)) : [];
  const saved = source === "all" || source === "saved" ? state.presets.filter((entry) => matches(entry.name, entry.description, templateFor(entry)?.id ?? entry.kind, entry.kind)) : [];
  const agencyEntries = source === "all" || source === "agency" ? catalog?.entries.filter((entry) => matches(entry.name, entry.category, `agency:${entry.category}`, entry.category)) ?? [] : [];
  const limitations = (kind: Preset["kind"]) => <>
    <p className="bot-inherits">{t("Inherits the selected Workspace model and effort. No bot model override.")}</p>
    {(kind === "scheduled" || kind === "event") && <p className="bot-warning">{t("Manual only. Saved schedules and events do not run automatically.")}</p>}
    {kind === "supervisor" && <p className="bot-warning">{t("Configure actual workers separately in Tutor mode. This preset does not spawn workers.")}</p>}
  </>;
  const feedback = <>
    {pending && <p role="status">{t("Saving or opening…")}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
  </>;
  if (!active) return null;
  return <section className="page bot-library" aria-label={t("Your bot library.")}>
    <div className="page-title">
      <div><p className="eyebrow">{t("REUSABLE WORKFLOWS")}</p><h1>{t("Your bot library.")}</h1>
        <p>{t("Built-in instruction templates, available offline. Add one to My bots or customize your own.")}</p>
        <p>{t("Use opens a new conversation without sending a message. Existing conversations stay unchanged.")}</p>
      </div>
      <div className="actions">
        <button disabled={pending} onClick={() => void perform(async () => { const s = unwrap(await api.presetImport()); if (s) { acceptState(s); setNotice(t("Imported into My bots.")); } })}>{t("Import JSON")}</button>
        <button disabled={pending} onClick={() => edit()}><Plus aria-hidden="true" />{t("New bot")}</button>
        <button disabled={pending || useLocked} onClick={() => use({ presetId: null })}>{t("Use Standard")}</button>
      </div>
    </div>
    <p className="bot-inherits">{t("Inherits the selected Workspace model and effort. No bot model override.")}</p>
    {useLocked && <p role="status">{t("Wait for the current engine operation or turn before using a bot.")}</p>}
    {!editor && !preview && !deleting && !agencyPreview && feedback}
    {notice && <p role="status">{notice}</p>}
    <div className="bot-filters">
      <label><span>{t("Search bots")}</span><div className="bot-search"><Search aria-hidden="true" /><input type="search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label={t("Search bots")} /></div></label>
      <label>{t("Source")}<select aria-label={t("Source")} value={source} onChange={(e) => setSource(e.target.value)}><option value="all">{t("All bots")}</option><option value="built-in">{t("Built-in")}</option><option value="saved">{t("My bots")}</option><option value="agency">Agency Agents</option></select></label>
      <label>{t("Category")}<select aria-label={t("Category")} value={category} onChange={(e) => setCategory(e.target.value)}><option value="all">{t("All categories")}</option>{Object.entries(kinds).map(([value, label]) => <option key={value} value={value}>{t(label)}</option>)}{[...new Set(catalog?.entries.map((entry) => entry.category))].sort().map((value) => <option key={`agency:${value}`} value={`agency:${value}`}>Agency Agents · {value}</option>)}</select></label>
    </div>
    {(source === "all" || source === "built-in") && <section aria-label={t("Built-in")}>
      <h2>{t("Built-in")}</h2>
      <div className="bot-grid">{templates.map((entry) => {
        const installed = state.presets.find((p) => p.id === templatePresetId(entry.id));
        const Icon = icons[entry.id] ?? Bot;
        return <article className="card bot-card" key={entry.id} data-bot-template={entry.id}>
          <div className="bot-card-heading"><Icon aria-hidden="true" /><h3>{templateName(entry)}</h3><span className="badge">{t("Built-in")} · v{entry.version}</span></div>
          <p>{templateDescription(entry)}</p>
          {entry.kind === "supervisor" && limitations(entry.kind)}
          {installed && <p className="muted">{t("Saved copy: {name}", { name: installed.name })}{!installed.enabled && ` · ${t("Disabled")}`}</p>}
          <div className="actions">
            <button disabled={pending || useLocked || installed?.enabled === false} onClick={() => use({ templateId: entry.id })}>{t("Use")}</button>
            <button disabled={pending} onClick={() => { setError(""); setPreview(entry); }}>{t("View instructions")}</button>
            <button disabled={pending} onClick={() => customize(entry)}>{t("Customize")}</button>
            <button disabled={pending || !!installed} onClick={() => void perform(() => install(entry))}>{installed ? t("Added") : t("Add to My bots")}</button>
          </div>
        </article>;
      })}</div>
    </section>}
    {(source === "all" || source === "saved") && <section aria-label={t("My bots")}>
      <div className="bot-section-heading"><h2>{t("My bots")}</h2>
        {state.preferences.defaultBotId && <button disabled={pending} onClick={() => void perform(async () => acceptState(unwrap(await api.preferences({ defaultBotId: null }))))}>{t("Reset default to Standard")}</button>}
      </div>
      {!state.presets.length && <p>{t("No saved bots yet. Built-in templates above are ready to add or use.")}</p>}
      <div className="bot-grid">{saved.map((entry) => {
        const origin = templateFor(entry), Icon = icons[origin?.id ?? entry.kind] ?? Bot;
        const isDefault = state.preferences.defaultBotId === entry.id;
        return <article className="card bot-card" key={entry.id} data-bot-id={entry.id}>
          <div className="bot-card-heading"><Icon aria-hidden="true" /><h3>{entry.name}</h3><span className="badge">{isDefault ? t("Default") : entry.enabled ? t("Preset ready") : t("Disabled")}</span></div>
          <p>{entry.description || t("No description")}</p><small>{t(kinds[entry.kind])}</small>
          {entry.source && <div className="bot-provenance"><p>{entry.source.managed ? t("Managed import") : t("Customized import")} · Agency Agents · MIT</p><p>{t("Revision")}: <code>{entry.source.revision}</code></p><p>{entry.source.managed ? t("Unmodified imports receive automatic updates when enabled. Edit creates a separate local copy.") : t("Customized bots are not overwritten by catalog updates.")}</p></div>}
          {limitations(entry.kind)}
          <div className="actions">
            <button disabled={pending || useLocked || !entry.enabled} onClick={() => use({ presetId: entry.id })}>{t("Use")}</button>
            <button disabled={pending} onClick={() => { setError(""); setPreview(entry); }}>{t("View instructions")}</button>
            <button disabled={pending || isDefault || !entry.enabled} onClick={() => void perform(async () => { acceptState(unwrap(await api.preferences({ defaultBotId: entry.id }))); setNotice(t("Default updated for future conversations.")); })}>{t("Set default")}</button>
            <button disabled={pending} onClick={() => edit(entry)}>{t("Edit")}</button>
            <button disabled={pending} onClick={() => edit(entry, true)}>{t("Duplicate")}</button>
            <button disabled={pending} onClick={() => void perform(async () => { if (unwrap(await api.presetExport(entry.id))) setNotice(t("Preset exported.")); })}>{t("Export")}</button>
            <button disabled={pending} onClick={() => { setError(""); setDeleting(entry); }}>{t("Delete preset")}</button>
          </div>
        </article>;
      })}</div>
    </section>}
    {(source === "all" || source === "agency") && <section className="bot-agency" aria-label="Agency Agents">
      <div className="bot-section-heading"><h2>Agency Agents</h2><button disabled={pending} onClick={() => void perform(async () => {
        catalogRequest.current++;
        try { acceptCatalog(unwrap(await api.botCatalogRead(true))); setCatalogError(""); }
        catch (e) { setCatalogError(e instanceof Error ? e.message : String(e)); }
        try { setUpdateStatus(unwrap(await api.botCatalogUpdates())); }
        catch (e) { setCatalogError(e instanceof Error ? e.message : String(e)); }
      })}>{t("Refresh catalog")}</button></div>
      <p>{t("External instruction profiles from Agency Agents (MIT). Review before importing; no tools, models or providers are installed and permissions do not change.")}</p>
      <label className="bot-auto"><input type="checkbox" role="switch" disabled={pending} checked={state.preferences.botCatalogAutomatic !== false} onChange={(event) => { const value = event.target.checked; void perform(async () => acceptState(unwrap(await api.preferences({ botCatalogAutomatic: value })))); }} />{t("Automatic catalog updates")}</label>
      <p>{t("Unmodified imports receive automatic updates when enabled. Edit creates a separate local copy.")} {t("Existing conversations keep their saved instruction snapshot.")}</p>
      <p>{t("Automatic checks run at startup and every 6 hours while Synora is running. When off, refresh is manual and managed bots are not auto-updated.")}</p>
      {catalog && <p className="bot-provenance">{t("Cached revision")}: <code>{catalog.revision}</code> · <time dateTime={new Date(catalog.fetchedAt).toISOString()}>{new Date(catalog.fetchedAt).toLocaleString(locale === "pt" ? "pt-PT" : locale)}</time> · MIT</p>}
      {updateStatus && <div className="bot-provenance">
        {updateStatus.checking && <p role="status">{t("Checking catalog updates…")}</p>}
        <p>{t("Last check")}: {updateStatus.lastCheckedAt ? new Date(updateStatus.lastCheckedAt).toLocaleString(locale === "pt" ? "pt-PT" : locale) : t("Not yet checked")}</p>
        <p>{t("Last successful update")}: {updateStatus.lastSuccessAt ? new Date(updateStatus.lastSuccessAt).toLocaleString(locale === "pt" ? "pt-PT" : locale) : t("Not yet checked")} · {t("Updated bots: {count}", { count: updateStatus.updated })}</p>
      </div>}
      {(catalogError || updateStatus?.error) && <div role="alert"><p>{catalog ? t("Refresh failed. Showing the previous cached catalog.") : t("Catalog unavailable. Built-in and saved bots still work.")}</p><p className="form-error">{catalogError || updateStatus?.error}</p></div>}
      {!catalog && <p>{catalogLoaded ? t("No cached catalog. Refresh to retrieve the Agency Agents index.") : t("Reading cached catalog…")}</p>}
      <div className="bot-grid">{agencyEntries.map((entry) => <article className="card bot-card" key={entry.id} data-agency-id={entry.id}>
        <div className="bot-card-heading"><Bot aria-hidden="true" /><h3>{entry.name}</h3><span className="badge">MIT</span></div><p>{entry.category}</p><small className="mono">{entry.path}</small>
        <div className="actions"><button disabled={pending} onClick={() => void perform(async () => { const result = unwrap(await api.botCatalogPreview(entry.id, catalog!.revision)); setReviewed(false); setAgencyPreview(result); })}>{t("Review profile")}</button></div>
      </article>)}</div>
    </section>}
    {!templates.length && !saved.length && !agencyEntries.length && <p role="status">{t("No bots match these filters.")}</p>}
    {agencyPreview && <Modal label={t("Review profile")} onDismiss={dismiss}>
      <div className="modal bot-modal"><div className="page-title"><h2>{agencyPreview.entry.name}</h2><button disabled={pending} aria-label={t("Close")} onClick={dismiss}><X aria-hidden="true" /></button></div>
        <p>{t("External instruction profiles from Agency Agents (MIT). Review before importing; no tools, models or providers are installed and permissions do not change.")}</p>
        <p>{t("Source")}: <span className="mono">{agencyPreview.sourceUrl}</span></p><p>{t("Revision")}: <code>{agencyPreview.revision}</code></p><p>SHA-256: <code>{agencyPreview.sha256}</code></p>
        {agencyPreview.warnings.length > 0 && <div className="bot-warning"><h3>{t("Review warnings")}</h3><ul>{agencyPreview.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></div>}
        <h3>{t("Original profile")}</h3><pre className="bot-instructions" tabIndex={0}>{agencyPreview.original}</pre>
        <h3>{t("Exact imported instructions")}</h3><pre className="bot-instructions" tabIndex={0}>{agencyPreview.instructions}</pre>
        <h3>{t("License")}</h3><pre className="bot-instructions" tabIndex={0}>{agencyPreview.licenseText}</pre>
        <label className="check"><input type="checkbox" disabled={pending} checked={reviewed} onChange={(event) => setReviewed(event.target.checked)} />{t("I reviewed the instructions, source and license.")}</label>
        {feedback}<div className="actions"><button disabled={pending} onClick={dismiss}>{t("Cancel")}</button><button disabled={pending || !reviewed} onClick={() => void perform(async () => { const result = unwrap(await api.botCatalogImport(agencyPreview.id, true)); acceptState(result.state); setAgencyPreview(null); setNotice(t("Imported into My bots.")); })}>{t("Import reviewed bot")}</button></div>
      </div>
    </Modal>}
    {preview && <Modal label={t("View instructions")} onDismiss={dismiss}>
      <div className="modal bot-modal"><div className="page-title"><h2>{"schema" in preview ? preview.name : templateName(preview)}</h2><button aria-label={t("Close")} onClick={dismiss}><X aria-hidden="true" /></button></div>
        {limitations(preview.kind)}<p>{t("Instructions are shown verbatim and are not translated.")}</p>
        <pre className="bot-instructions" tabIndex={0}>{preview.instructions || t("No instructions")}</pre>
        {"schema" in preview && preview.source && <>
          <p>{preview.source.managed ? t("Managed import") : t("Customized import")} · Agency Agents</p>
          <p>{t("Source")}: <span className="mono">{preview.source.sourceUrl}</span></p>
          <p>{t("Revision")}: <code>{preview.source.revision}</code></p>
          <p>SHA-256: <code>{preview.source.sha256}</code></p>
          <h3>{t("License")}</h3><pre className="bot-instructions" tabIndex={0}>{preview.source.licenseText}</pre>
        </>}
      </div>
    </Modal>}
    {deleting && <Modal label={t("Delete preset")} onDismiss={dismiss}>
      <div className="modal bot-modal"><h2>{t("Delete {name}?", { name: deleting.name })}</h2><p>{t("This removes the saved bot. Existing conversations keep their instructions. Export first if you need a backup.")}</p>
        {state.preferences.defaultBotId === deleting.id && <p>{t("The default will reset to Standard.")}</p>}
        {feedback}<div className="actions"><button disabled={pending} onClick={dismiss}>{t("Cancel")}</button><button disabled={pending} onClick={() => void perform(async () => { acceptState(unwrap(await api.presetDelete(deleting.id))); setDeleting(null); setNotice(t("Bot deleted.")); })}>{t("Delete preset")}</button></div>
      </div>
    </Modal>}
    {editor && <Modal label={editor.id ? t("Edit bot") : t("New bot preset")} onDismiss={dismiss}>
      <form className="modal bot-modal" aria-busy={pending} onSubmit={(event) => { event.preventDefault(); void perform(async () => { const { id, ...value } = editor; acceptState(unwrap(await api.presetSave(value, id))); setEditor(null); setNotice(t("Bot saved.")); }); }}>
        <div className="page-title"><h2>{editor.id ? t("Edit bot") : t("New bot preset")}</h2><button type="button" disabled={pending} aria-label={t("Close bot editor")} onClick={dismiss}><X aria-hidden="true" /></button></div>
        <label>{t("Name")}<input aria-label={t("Bot name")} required maxLength={80} disabled={pending} value={editor.name} onChange={(e) => setEditor({ ...editor, name: e.target.value })} /></label>
        <label>{t("Description")}<textarea maxLength={500} disabled={pending} value={editor.description} onChange={(e) => setEditor({ ...editor, description: e.target.value })} /></label>
        <label>{t("Instructions")}<textarea aria-label={t("Bot instructions")} className="bot-editor-instructions" maxLength={16000} disabled={pending} value={editor.instructions} onChange={(e) => setEditor({ ...editor, instructions: e.target.value })} /></label>
        <label>{t("Type")}<select disabled={pending} value={editor.kind} onChange={(e) => setEditor({ ...editor, kind: e.target.value as Preset["kind"] })}>{Object.entries(kinds).map(([kind, label]) => <option value={kind} key={kind}>{t(label)}</option>)}</select></label>
        {limitations(editor.kind)}<p className="muted">{t("Legacy profile/context remain in JSON for compatibility; they do not control this session.")}</p>
        <label className="check"><input type="checkbox" disabled={pending} checked={editor.enabled} onChange={(e) => setEditor({ ...editor, enabled: e.target.checked })} />{t("Enable preset (does not start a bot)")}</label>
        {feedback}<div className="actions"><button type="button" disabled={pending} onClick={dismiss}>{t("Cancel")}</button><button type="submit" className="primary" disabled={pending}>{t("Save preset")}</button></div>
      </form>
    </Modal>}
  </section>;
}
