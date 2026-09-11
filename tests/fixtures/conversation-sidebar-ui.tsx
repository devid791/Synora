import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ConversationSidebar } from "../../src/renderer/ConversationSidebar";
import { ConversationStarters } from "../../src/renderer/ConversationStarters";
import { conversationTranscript } from "../../src/shared/conversation-management";
import type { AppState, Conversation } from "../../src/shared/contracts";
const w = window as any;
w.calls = [];
const seed = {
  preferences: { conversationGrouping: "list", conversationSort: "created" },
  workspaces: [{ id: "w1", name: "Project One", path: "/one" }, { id: "w2", name: "Project Two", path: "/two" }],
  conversations: Array.from({ length: w.largeHistory ? 72 : 3 }, (_, i) => ({
    id: `c${i}`, title: i === 0 ? "Alpha" : i === 1 ? "Zeta" : `Chat ${i}`, workspaceId: i === 0 ? "w1" : "w2",
    draft: "Original unsent text", createdAt: 1000 - i, itemOrder: [], activity: [],
    messages: [{ id: `m${i}`, role: "user", text: `Saved message ${i}`, simulated: false }],
  })),
} as unknown as AppState;
function App() {
  const [state, setState] = useState(seed), [selected, setSelected] = useState("c0"), [draft, setDraft] = useState("Original unsent text");
  w.snapshot = () => state;
  w.draft = () => draft;
  return <div className="app"><aside className="sidebar">
    <ConversationSidebar state={state} selected={selected} activeId="c0" busy={!!w.engineBusy}
      writeClipboard={w.nativeClipboard ? async text => { if (w.failNativeClipboard) throw Error("Native clipboard failed"); w.nativeCopied = text; } : undefined}
      open={async id => { w.calls.push("open"); setSelected(id); setState(s => ({ ...s, conversations: s.conversations.map(c => c.id === id ? { ...c, unread: false } : c) })); }}
      update={async (id, patch) => { w.calls.push({ id, patch }); if (w.failUpdate) throw Error("Controlled save failure");
        setState(s => ({ ...s, conversations: s.conversations.map(c => c.id === id ? { ...c, ...patch } : c) })); }}
      preference={async patch => { w.calls.push({ preference: patch }); setState(s => ({ ...s, preferences: { ...s.preferences, ...patch } })); }}
      remove={async id => { if (w.failDelete) throw Error("Controlled delete failure"); w.calls.push({ delete: id });
        setState(s => ({ ...s, conversations: s.conversations.filter(c => c.id !== id) })); return undefined; }}
      fork={async id => { w.calls.push({ fork: id }); const source = state.conversations.find(c => c.id === id)!;
        const c = { ...source, id: "new-fork", draft: conversationTranscript(source), title: `${source.title} (fork)`, messages: [], activity: [], itemOrder: [] } as Conversation;
        setState(s => ({ ...s, conversations: [c, ...s.conversations] })); setSelected(c.id); setDraft(c.draft); }} />
  </aside><main style={{ padding: 16, flex: 1, minWidth: 0 }}><div className="welcome"><ConversationStarters draft={draft} choose={setDraft} /></div>
    <textarea aria-label="Draft" value={draft} onChange={e => setDraft(e.currentTarget.value)} /></main></div>;
}
createRoot(document.getElementById("root")!).render(<App />);
