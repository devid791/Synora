import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Archive, Check, ChevronLeft, ChevronRight, Columns2, Copy, Eye, Folder, GitFork, MoreHorizontal, Pencil, Pin, Trash2, X } from "lucide-react";
import type { AppState, Conversation } from "../shared/contracts";
import { conversationGroups, conversationTranscript, type ConversationPatch } from "../shared/conversation-management";
import { Modal } from "./Modal";
import { useI18n } from "./i18n";
import { messages } from "./locales/conversations";
import { messages as splitMessages } from "./locales/split-view";

type Menu = { id: string | null; x: number; y: number; opener: HTMLElement };
export function ConversationSidebar({ state, selected, activeId, busy, open, update, preference, fork, remove, inspect, onOverlayChange, writeClipboard = text => navigator.clipboard.writeText(text) }: {
  state: AppState; selected: string; activeId?: string | null; busy: boolean;
  open: (id: string) => Promise<void>;
  update: (id: string, patch: ConversationPatch) => Promise<void>;
  preference: (patch: Partial<AppState["preferences"]>) => Promise<void>;
  fork: (id: string) => Promise<void>;
  remove: (id: string) => Promise<string | undefined>;
  inspect?: (id: string) => void;
  onOverlayChange?: (open: boolean) => void;
  writeClipboard?: (text: string) => Promise<void>;
}) {
  const { t } = useI18n(messages);
  const { t: splitText } = useI18n(splitMessages);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [sub, setSub] = useState("main");
  const [archived, setArchived] = useState(false);
  const [limit, setLimit] = useState(50);
  const [dialog, setDialog] = useState<{ kind: "rename" | "fork" | "delete"; id: string } | null>(null);
  const [title, setTitle] = useState("");
  const [pending, setPending] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const applying = useRef(false), popup = useRef<HTMLDivElement>(null);
  const current = state.conversations.find(c => c.id === menu?.id);
  const target = state.conversations.find(c => c.id === dialog?.id);
  useLayoutEffect(() => { onOverlayChange?.(!!menu || !!dialog); }, [!!menu, !!dialog, onOverlayChange]);
  useEffect(() => () => onOverlayChange?.(false), [onOverlayChange]);
  const locked = (c: Conversation) => (busy && activeId === c.id) || !!c.queuedMessages?.some(m => m.status !== "held");
  const deletionLocked = (c: Conversation) => busy || locked(c) || !!state.delegations?.some(t => ["queued", "running"].includes(t.status));
  const dialogLabel = dialog?.kind === "delete" ? "Delete conversation" : dialog?.kind === "rename" ? "Rename conversation" : "Fork as new draft";
  const close = (focus = false) => {
    popup.current?.hidePopover();
    if (focus) menu?.opener.focus({ preventScroll: true });
    setMenu(null);
  };
  const position = () => {
    if (!popup.current || !menu) return;
    popup.current.style.left = `${Math.max(8, Math.min(menu.x, innerWidth - popup.current.offsetWidth - 8))}px`;
    popup.current.style.top = `${Math.max(8, Math.min(menu.y, innerHeight - popup.current.offsetHeight - 8))}px`;
  };
  useLayoutEffect(() => {
    if (!menu || !popup.current) return;
    popup.current.showPopover(); position();
    popup.current.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [menu, sub]);
  useEffect(() => {
    if (!menu) return;
    window.addEventListener("resize", position);
    const dismiss = (e: Event) => { if (!popup.current?.contains(e.target as Node) && !menu.opener.contains(e.target as Node)) close(); };
    document.addEventListener("pointerdown", dismiss, true);
    document.addEventListener("wheel", dismiss, { capture: true, passive: true });
    return () => { window.removeEventListener("resize", position); document.removeEventListener("pointerdown", dismiss, true); document.removeEventListener("wheel", dismiss, true); };
  }, [menu]);
  useEffect(() => { if (state.preferences.sidebarCollapsed) close(); }, [state.preferences.sidebarCollapsed]);
  const show = (id: string | null, opener: HTMLElement, point?: { x: number; y: number }) => {
    if (pending) return;
    const r = opener.getBoundingClientRect();
    setSub("main"); setMenu({ id, opener, x: point?.x ?? r.left, y: point?.y ?? r.bottom + 5 });
  };
  const perform = async (fn: () => Promise<void>) => {
    if (applying.current) return;
    applying.current = true; setPending(true); setError(""); setNotice("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { applying.current = false; setPending(false); }
  };
  const change = (patch: ConversationPatch) => { const id = current?.id; close(true); if (id) void perform(() => update(id, patch)); };
  const choosePreference = (patch: Partial<AppState["preferences"]>) => { close(true); void perform(() => preference(patch)); };
  const keyboard = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape" || e.key === "Tab") { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); } close(true); return; }
    if (e.key === "ArrowLeft" && sub !== "main") { e.preventDefault(); setSub("main"); return; }
    if (e.key === "ArrowRight" && (e.target as HTMLElement).getAttribute("aria-haspopup") === "menu") { e.preventDefault(); (e.target as HTMLButtonElement).click(); return; }
    const buttons = [...(popup.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? buttons.length - 1 : e.key === "ArrowDown" ? (i + 1) % buttons.length : e.key === "ArrowUp" ? (i - 1 + buttons.length) % buttons.length : -1;
    if (next >= 0) { e.preventDefault(); buttons[next]?.focus(); }
  };
  const copy = (text: string) => { close(true); void perform(async () => {
    try { await writeClipboard(text); } catch { throw Error(t("Clipboard access failed. Nothing was copied.")); }
    setNotice(t("Copied"));
  }); };
  const groups = conversationGroups(state.conversations, state.workspaces, state.preferences.conversationGrouping ?? "list", state.preferences.conversationSort ?? "updated", archived);
  let shown = 0;
  const total = groups.reduce((n, g) => n + g.conversations.length, 0);
  return <>
    <div className="side-heading conversation-heading"><span>{t(archived ? "Archived conversations" : "Recent conversations")}</span>
      <button aria-label={t("Sidebar options")} aria-haspopup="menu" aria-expanded={!!menu && menu.id === null} disabled={pending}
        onClick={e => show(null, e.currentTarget)}><MoreHorizontal size={17} /></button></div>
    <div className="history conversation-history">
      {groups.map(group => {
        const entries = group.conversations.slice(0, Math.max(0, limit - shown)); shown += entries.length;
        if (!entries.length) return null;
        return <section key={group.id} className="conversation-group" aria-label={group.name ?? t("No project")}>
          {state.preferences.conversationGrouping === "project" && <h3><Folder size={13} />{group.name ?? t("No project")}</h3>}
          {entries.map(c => <div className={`conversation-row ${selected === c.id ? "selected" : ""}`} key={c.id}
            onContextMenu={e => { e.preventDefault(); show(c.id, e.currentTarget.querySelector<HTMLButtonElement>(".conversation-more")!, { x: e.clientX, y: e.clientY }); }}>
            <button className="conversation-open" aria-label={t("Open conversation: {title}", { title: c.title })}
              aria-current={selected === c.id ? "page" : undefined} disabled={pending} title={c.title}
              onClick={() => void perform(() => open(c.id))}
              onKeyDown={e => { if (e.key === "ContextMenu" || (e.shiftKey && e.key === "F10")) { e.preventDefault(); show(c.id, e.currentTarget); } }}>
              {c.pinned && <Pin size={13} aria-label={t("Pinned")} />}<span>{c.title}</span>{c.unread && <i className="dot" aria-label={t("Unread")} />}
            </button>
            <button className="conversation-more" aria-label={t("Conversation actions: {title}", { title: c.title })} aria-haspopup="menu"
              aria-expanded={menu?.id === c.id} disabled={pending} onClick={e => show(c.id, e.currentTarget)}><MoreHorizontal size={16} /></button>
          </div>)}
        </section>;
      })}
      {!total && <p className="hint">{t(archived ? "No archived conversations" : "No conversations yet")}</p>}
      {total > limit && <button onClick={() => setLimit(v => v + 50)}>{t("Show more conversations")}</button>}
      {archived && <button onClick={() => { setArchived(false); setLimit(50); }}>{t("Back to recent conversations")}</button>}
    </div>
    {error && <p className="conversation-feedback" role="alert">{error}</p>}
    {notice && <p className="conversation-feedback" role="status">{notice}</p>}
    <div ref={popup} className="conversation-menu" popover="manual" role="menu" aria-label={t(menu?.id ? "Conversation actions" : "Sidebar options")}
      onKeyDown={keyboard} onToggle={e => { if ((e.nativeEvent as ToggleEvent).newState === "closed" && !popup.current?.matches(":popover-open")) setMenu(null); }}>
      {sub !== "main" && <button role="menuitem" onClick={() => setSub("main")}><ChevronLeft />{t("Back")}</button>}
      {sub === "main" && (current ? <>
        {inspect && <button role="menuitem" onClick={() => { const id = current.id; close(true); inspect(id); }}><Columns2 />{splitText("Open beside")}</button>}
        <button role="menuitem" onClick={() => { const id = current.id; setTitle(current.title); close(true); setDialog({ kind: "rename", id }); }}><Pencil />{t("Rename")}</button>
        <button role="menuitem" onClick={() => change({ pinned: !current.pinned })}><Pin />{t(current.pinned ? "Unpin" : "Pin")}</button>
        <button role="menuitem" onClick={() => change({ unread: !current.unread })}><Eye />{t(current.unread ? "Mark as read" : "Mark as unread")}</button>
        <button role="menuitem" disabled={locked(current)} title={locked(current) ? t("Wait for active and queued turns to finish.") : undefined}
          onClick={() => change({ archived: !current.archived })}><Archive />{t(current.archived ? "Unarchive" : "Archive")}</button>
        <button role="menuitem" className="conversation-delete" disabled={deletionLocked(current)}
          title={deletionLocked(current) ? t("Wait for active and queued turns to finish.") : undefined}
          onClick={() => { const id = current.id; setError(""); close(true); setDialog({ kind: "delete", id }); }}><Trash2 />{t("Delete conversation")}</button>
        <hr /><button role="menuitem" aria-haspopup="menu" onClick={() => setSub("project")}><Folder />{t("Project")}<ChevronRight /></button>
        <hr /><button role="menuitem" aria-haspopup="menu" onClick={() => setSub("copy")}><Copy />{t("Copy")}<ChevronRight /></button>
        <hr /><button role="menuitem" disabled={locked(current) || !current.messages.length || current.messages.some(m => m.incomplete)}
          title={t("Create an independent draft from the saved text; live tool state is not cloned.")}
          onClick={() => { const id = current.id; close(true); setDialog({ kind: "fork", id }); }}><GitFork />{t("Fork as new draft")}</button>
      </> : <>
        <button role="menuitem" aria-haspopup="menu" onClick={() => setSub("group")}><Folder />{t("Organize sidebar")}<ChevronRight /></button>
        <button role="menuitem" aria-haspopup="menu" onClick={() => setSub("sort")}><ChevronRight />{t("Sort chats by")}<ChevronRight /></button>
        <hr /><button role="menuitemcheckbox" aria-checked={archived} onClick={() => { close(true); setArchived(v => !v); setLimit(50); }}><Archive />{t("Show archived")}</button>
      </>)}
      {sub === "group" && ([['project', 'By project'], ['list', 'In one list']] as const).map(([value, label]) =>
        <button key={value} role="menuitemradio" aria-checked={(state.preferences.conversationGrouping ?? "list") === value} onClick={() => choosePreference({ conversationGrouping: value })}>
          <Check className={(state.preferences.conversationGrouping ?? "list") === value ? "" : "check-hidden"} />{t(label)}</button>)}
      {sub === "sort" && ([['updated', 'Recent activity'], ['created', 'Date created'], ['title', 'Title']] as const).map(([value, label]) =>
        <button key={value} role="menuitemradio" aria-checked={(state.preferences.conversationSort ?? "updated") === value} onClick={() => choosePreference({ conversationSort: value })}>
          <Check className={(state.preferences.conversationSort ?? "updated") === value ? "" : "check-hidden"} />{t(label)}</button>)}
      {sub === "project" && current && <><p>{t("Organizes the sidebar only. The execution folder stays unchanged.")}</p>
        {[{ id: null, name: t("No project") }, ...state.workspaces].map(w => <button key={w.id ?? "none"} role="menuitemradio"
          aria-checked={(current.projectId === undefined ? current.workspaceId : current.projectId) === w.id}
          onClick={() => change({ projectId: w.id })}><Folder />{w.name}</button>)}</>}
      {sub === "copy" && current && <>
        <button role="menuitem" onClick={() => copy(current.title)}>{t("Copy title")}</button>
        <button role="menuitem" onClick={() => copy(current.id)}>{t("Copy conversation ID")}</button>
        <button role="menuitem" disabled={!current.messages.length} onClick={() => copy(conversationTranscript(current))}>{t("Copy conversation text")}</button>
      </>}
    </div>
    {dialog && target && <Modal label={t(dialogLabel)} onDismiss={() => { if (!pending) setDialog(null); }}>
      <form className="modal conversation-dialog" onSubmit={e => { e.preventDefault(); void perform(async () => {
        if (dialog.kind === "rename") await update(target.id, { title: title.trim() });
        else if (dialog.kind === "delete") {
          if (deletionLocked(target)) throw Error(t("Wait for active and queued turns to finish."));
          const warning = await remove(target.id);
          setNotice(warning ? t(warning) : t("Conversation deleted"));
        } else await fork(target.id);
        setDialog(null);
      }); }}>
        <div className="page-title"><h2>{t(dialogLabel)}</h2>
          <button type="button" aria-label={t("Close")} disabled={pending} onClick={() => setDialog(null)}><X /></button></div>
        {dialog.kind === "rename" ? <label>{t("Title")}<input autoComplete="off" value={title} maxLength={160} required disabled={pending} onChange={e => setTitle(e.currentTarget.value)} /></label>
          : dialog.kind === "delete" ? <><p><strong>{target.title}</strong></p>
            <p>{t("Permanently delete this conversation, its draft and local attachments from Synora? This cannot be undone.")}</p>
            <p className="muted">{t("Project files and copies retained by Core or external providers are not deleted.")}</p></>
          : <><p>{t("Create an independent draft from the saved text; live tool state is not cloned.")}</p>
            <p>{t("Images, unsent drafts and tool results are not copied. Review the text and selected provider before sending; nothing is sent automatically.")}</p></>}
        {error && <p role="alert">{error}</p>}
        <div className="dialog-actions"><button type="button" disabled={pending} onClick={() => setDialog(null)}>{t("Cancel")}</button>
          <button type="submit" className={dialog.kind === "delete" ? "conversation-delete" : undefined}
            disabled={pending || (dialog.kind === "rename" && !title.trim()) || (dialog.kind === "delete" && deletionLocked(target))}>{t(dialog.kind === "delete" ? "Delete permanently" : dialog.kind === "rename" ? "Save" : "Create draft")}</button></div>
      </form>
    </Modal>}
  </>;
}
