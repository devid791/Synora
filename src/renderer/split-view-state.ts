import type { AppState, EngineSnapshot } from "../shared/contracts";

export type SideTarget =
  | { kind: "agent"; id: string }
  | { kind: "conversation"; id: string }
  | { kind: "task"; id: string; parentId: string };
export type SplitViewState = {
  visible: boolean;
  tabs: SideTarget[];
  selected: string;
  width: number;
};
export const sideKey = (target: SideTarget) =>
  JSON.stringify(
    target.kind === "task"
      ? [target.kind, target.parentId, target.id]
      : [target.kind, target.id],
  );
export const emptySplitView = (): SplitViewState => ({
  visible: false,
  tabs: [],
  selected: "",
  width: 46,
});
export const splitWidth = (value: number) =>
  Math.max(30, Math.min(65, Number.isFinite(value) ? value : 46));
export function parseSplitView(value: string | null): SplitViewState {
  try {
    const v = JSON.parse(value ?? "null");
    if (
      !v ||
      typeof v !== "object" ||
      !Array.isArray(v.tabs) ||
      v.tabs.length > 12
    )
      return emptySplitView();
    const tabs: SideTarget[] = [];
    for (const t of v.tabs) {
      if (!t || typeof t.id !== "string" || !t.id || t.id.length > 512)
        continue;
      const target: SideTarget | null =
        t.kind === "agent" || t.kind === "conversation"
          ? { kind: t.kind, id: t.id }
          : t.kind === "task" &&
              typeof t.parentId === "string" &&
              t.parentId.length > 0 &&
              t.parentId.length <= 512
            ? { kind: "task", id: t.id, parentId: t.parentId }
            : null;
      if (target && !tabs.some((item) => sideKey(item) === sideKey(target)))
        tabs.push(target);
    }
    return {
      visible: v.visible === true,
      tabs,
      selected: tabs.some((t) => sideKey(t) === v.selected)
        ? v.selected
        : tabs[0]
          ? sideKey(tabs[0])
          : "",
      width: splitWidth(typeof v.width === "number" ? v.width : 46),
    };
  } catch {
    return emptySplitView();
  }
}
export function sideSources(state: AppState, engine: EngineSnapshot) {
  const agents = new Map(state.agentHistory.map((a) => [a.id, a]));
  for (const agent of engine.agents) agents.set(agent.id, agent);
  return {
    agents: [...agents.values()],
    conversations: state.conversations,
    tasks: state.delegations,
  };
}
export function sideExists(
  target: SideTarget,
  sources: ReturnType<typeof sideSources>,
) {
  return target.kind === "agent"
    ? sources.agents.some((a) => a.id === target.id)
    : target.kind === "conversation"
      ? sources.conversations.some((c) => c.id === target.id)
      : sources.tasks.some(
          (t) =>
            t.id === target.id && t.parentConversationId === target.parentId,
        );
}
export function pruneSplitView(
  view: SplitViewState,
  sources: ReturnType<typeof sideSources>,
): SplitViewState {
  const tabs = view.tabs.filter((t) => sideExists(t, sources));
  if (tabs.length === view.tabs.length) return view;
  return {
    ...view,
    tabs,
    selected: tabs.some((t) => sideKey(t) === view.selected)
      ? view.selected
      : tabs[0]
        ? sideKey(tabs[0])
        : "",
  };
}
export function openSide(
  view: SplitViewState,
  target: SideTarget,
): SplitViewState {
  const key = sideKey(target);
  if (view.tabs.some((t) => sideKey(t) === key))
    return { ...view, visible: true, selected: key };
  // Never silently evict an existing tab.
  if (view.tabs.length === 12) return { ...view, visible: true };
  return {
    ...view,
    visible: true,
    tabs: [...view.tabs, target],
    selected: key,
  };
}
export function closeSide(view: SplitViewState, key: string): SplitViewState {
  const index = view.tabs.findIndex((t) => sideKey(t) === key),
    tabs = view.tabs.filter((t) => sideKey(t) !== key);
  return {
    ...view,
    tabs,
    selected:
      key !== view.selected
        ? view.selected
        : tabs.length
          ? sideKey(tabs[Math.min(index, tabs.length - 1)])
          : "",
  };
}

export type ReportedEntry = {
  id: string;
  kind: "user" | "assistant" | "activity";
  text: string;
  raw: unknown;
};
/** Render reported content only. Unknown items remain inspectable, never inferred messages. */
export function reportedEntries(items: readonly unknown[]): ReportedEntry[] {
  const entries = new Map<string, ReportedEntry>();
  items.forEach((raw, index) => {
    const item =
      raw && typeof raw === "object" && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    const id = typeof item.id === "string" ? item.id : `unidentified-${index}`;
    const kind =
      item.type === "agentMessage" && typeof item.text === "string"
        ? "assistant"
        : item.type === "userMessage" && Array.isArray(item.content)
          ? "user"
          : "activity";
    const text =
      kind === "assistant"
        ? (item.text as string)
        : kind === "user"
          ? (item.content as unknown[])
              .flatMap((v) => {
                const part =
                  v && typeof v === "object"
                    ? (v as Record<string, unknown>)
                    : {};
                return part.type === "text" && typeof part.text === "string"
                  ? [part.text]
                  : [];
              })
              .join("\n")
          : typeof item.type === "string"
            ? item.type
            : "";
    entries.set(id, { id, kind, text, raw });
  });
  return [...entries.values()];
}
