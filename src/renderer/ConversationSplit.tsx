import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { Columns2, Plus, X } from "lucide-react";
import type { AppState, DesktopAPI, EngineSnapshot } from "../shared/contracts";
import { useI18n } from "./i18n";
import { messages } from "./locales/split-view";
import {
  closeSide,
  openSide,
  parseSplitView,
  pruneSplitView,
  reportedEntries,
  sideExists,
  sideKey,
  sideSources,
  splitWidth,
  type SideTarget,
} from "./split-view-state";
import { conversationTimeline } from "./conversation-timeline";
import { AttachedImage } from "./Images";
import { ToolActivity } from "./ToolActivity";
import { MessageText } from "./MessageText";

const storageKey = "synora.split-view.v1";
export function useConversationSplit(
  state: AppState | null,
  engine: EngineSnapshot,
) {
  const [value, set] = useState(() => {
    try {
      return parseSplitView(localStorage.getItem(storageKey));
    } catch {
      return parseSplitView(null);
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch {
      /* Layout storage must not block the app. */
    }
  }, [value]);
  useEffect(() => {
    if (state) set((v) => pruneSplitView(v, sideSources(state, engine)));
  }, [state, engine.agents]);
  return {
    value,
    set,
    open: (target: SideTarget) => {
      if (state && sideExists(target, sideSources(state, engine)))
        set((v) => openSide(v, target));
    },
    toggle: () => set((v) => ({ ...v, visible: !v.visible })),
  };
}
export type SplitController = ReturnType<typeof useConversationSplit>;
export function SplitToggle({ split }: { split: SplitController }) {
  const { t } = useI18n(messages);
  return (
    <button
      id="synora-split-toggle"
      type="button"
      aria-label={t(
        split.value.visible ? "Close side panel" : "Open side panel",
      )}
      title={t("Agents, bots and conversations")}
      aria-expanded={split.value.visible}
      aria-controls="synora-side-reader"
      onClick={split.toggle}
    >
      <Columns2 />
    </button>
  );
}
export function OpenBeside({ open }: { open: () => void }) {
  const { t } = useI18n(messages);
  return (
    <button type="button" onClick={open}>
      <Columns2 />
      {t("Open beside")}
    </button>
  );
}
export function RelatedSideTabs({
  state,
  engine,
  conversationId,
  open,
}: {
  state: AppState;
  engine: EngineSnapshot;
  conversationId: string;
  open: (target: SideTarget) => void;
}) {
  const { t } = useI18n(messages);
  const current = state.conversations.find((c) => c.id === conversationId);
  if (!current) return null;
  const sources = sideSources(state, engine);
  const agents = sources.agents.filter(
    (a) =>
      a.parentId === current.id || a.parentId === current.binding?.threadId,
  );
  const tasks = sources.tasks.filter(
    (task) => task.parentConversationId === current.id,
  );
  if (!agents.length && !tasks.length) return null;
  return (
    <div
      className="related-side-tabs"
      aria-label={t("Agents, bots and conversations")}
    >
      {agents.map((a) => (
        <button
          key={`agent:${a.id}`}
          type="button"
          aria-label={t("Open beside: {name}", { name: a.name })}
          onClick={() => open({ kind: "agent", id: a.id })}
        >
          <Columns2 />
          <span>{a.name}</span>
          <small>{a.simulated ? t("Simulated") : a.status}</small>
        </button>
      ))}
      {tasks.map((task) => (
        <button
          key={`task:${task.id}`}
          type="button"
          aria-label={t("Open beside: {name}", { name: task.name })}
          onClick={() =>
            open({
              kind: "task",
              id: task.id,
              parentId: task.parentConversationId,
            })
          }
        >
          <Columns2 />
          <span>{task.name}</span>
          <small>{task.status}</small>
        </button>
      ))}
    </div>
  );
}
export function ConversationSplit({
  state,
  engine,
  api,
  split,
  children,
}: {
  state: AppState;
  engine: EngineSnapshot;
  api: DesktopAPI;
  split: SplitController;
  children: ReactNode;
}) {
  const { t } = useI18n(messages);
  const { value, set } = split;
  const sources = sideSources(state, engine);
  const root = useRef<HTMLDivElement>(null),
    chooser = useRef<HTMLSelectElement>(null);
  const [narrow, setNarrow] = useState(false);
  const [picking, setPicking] = useState(false);
  useLayoutEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([e]) =>
      setNarrow(e.contentRect.width < 760),
    );
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const title = (target: SideTarget) =>
    target.kind === "agent"
      ? (sources.agents.find((a) => a.id === target.id)?.name ?? target.id)
      : target.kind === "task"
        ? (sources.tasks.find(
            (a) =>
              a.id === target.id && a.parentConversationId === target.parentId,
          )?.name ?? target.id)
        : (() => {
            const c = sources.conversations.find((a) => a.id === target.id);
            return c
              ? `${c.defaults?.bot ? `${c.defaults.bot.name} · ` : ""}${c.title}`
              : target.id;
          })();
  const selected = value.tabs.find(
    (target) => sideKey(target) === value.selected,
  );
  const options: { label: string; targets: SideTarget[] }[] = [
    {
      label: "Agents",
      targets: sources.agents.map(
        (a) => ({ kind: "agent", id: a.id }) as const,
      ),
    },
    {
      label: "Worker tasks",
      targets: sources.tasks.map(
        (a) =>
          ({
            kind: "task",
            id: a.id,
            parentId: a.parentConversationId,
          }) as const,
      ),
    },
    {
      label: "Bot conversations",
      targets: sources.conversations
        .filter((c) => c.defaults?.bot)
        .map((c) => ({ kind: "conversation", id: c.id }) as const),
    },
    {
      label: "Conversations",
      targets: sources.conversations
        .filter((c) => !c.defaults?.bot)
        .map((c) => ({ kind: "conversation", id: c.id }) as const),
    },
  ];
  useEffect(() => {
    if (picking) chooser.current?.focus();
  }, [picking]);
  const resize = (percentage: number) =>
    set((v) => ({ ...v, width: splitWidth(percentage) }));
  const closeTab = (key: string) => {
    set((v) => closeSide(v, key));
    requestAnimationFrame(() => {
      const next = root.current?.querySelector<HTMLButtonElement>(
        '[role="tab"][aria-selected="true"]',
      );
      if (next) next.focus();
      else chooser.current?.focus();
    });
  };
  return (
    <div
      ref={root}
      className={`conversation-split ${value.visible ? "split-open" : ""} ${narrow ? "split-narrow" : ""}`}
      style={{ "--side-size": `${value.width}%` } as CSSProperties}
    >
      <div className="split-primary">{children}</div>
      {value.visible && (
        <>
          <div
            role="separator"
            tabIndex={0}
            className="split-divider"
            aria-label={t("Resize side panel")}
            aria-orientation={narrow ? "horizontal" : "vertical"}
            aria-controls="synora-side-reader"
            aria-valuemin={30}
            aria-valuemax={65}
            aria-valuenow={Math.round(value.width)}
            onKeyDown={(e) => {
              const increase = narrow
                ? e.key === "ArrowUp"
                : e.key === "ArrowLeft";
              const decrease = narrow
                ? e.key === "ArrowDown"
                : e.key === "ArrowRight";
              if (increase || decrease || e.key === "Home" || e.key === "End") {
                e.preventDefault();
                resize(
                  e.key === "Home"
                    ? 30
                    : e.key === "End"
                      ? 65
                      : value.width + (increase ? 2 : -2),
                );
              }
            }}
            onPointerDown={(e) => {
              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              if (
                !e.currentTarget.hasPointerCapture(e.pointerId) ||
                !root.current
              )
                return;
              const r = root.current.getBoundingClientRect();
              resize(
                narrow
                  ? (100 * (r.bottom - e.clientY)) / r.height
                  : (100 * (r.right - e.clientX)) / r.width,
              );
            }}
            onPointerUp={(e) => {
              if (e.currentTarget.hasPointerCapture(e.pointerId))
                e.currentTarget.releasePointerCapture(e.pointerId);
            }}
          />
          <aside
            id="synora-side-reader"
            className="side-reader"
            aria-label={t("Agents, bots and conversations")}
          >
            <header className="side-reader-header">
              <div
                className="side-tabs"
                role="tablist"
                aria-label={t("Agents, bots and conversations")}
              >
                {value.tabs.map((target, index) => {
                  const key = sideKey(target),
                    name = title(target),
                    active = key === value.selected;
                  return (
                    <div
                      className={`side-tab ${active ? "selected" : ""}`}
                      key={key}
                    >
                      <button
                        type="button"
                        role="tab"
                        id={`side-tab-${index}`}
                        aria-selected={active}
                        tabIndex={active ? 0 : -1}
                        aria-controls="side-reader-content"
                        title={name}
                        onClick={() => set((v) => ({ ...v, selected: key }))}
                        onKeyDown={(e) => {
                          const next =
                            e.key === "ArrowRight"
                              ? (index + 1) % value.tabs.length
                              : e.key === "ArrowLeft"
                                ? (index - 1 + value.tabs.length) %
                                  value.tabs.length
                                : e.key === "Home"
                                  ? 0
                                  : e.key === "End"
                                    ? value.tabs.length - 1
                                    : -1;
                          if (next >= 0) {
                            e.preventDefault();
                            set((v) => ({
                              ...v,
                              selected: sideKey(v.tabs[next]),
                            }));
                            e.currentTarget
                              .closest('[role="tablist"]')
                              ?.querySelectorAll<HTMLButtonElement>(
                                '[role="tab"]',
                              )
                              [next]?.focus();
                          }
                          if (e.key === "Delete") {
                            e.preventDefault();
                            closeTab(key);
                          }
                        }}
                      >
                        <span>{name}</span>
                      </button>
                      <button
                        type="button"
                        className="side-tab-close"
                        aria-label={t("Close tab: {name}", { name })}
                        onClick={() => closeTab(key)}
                      >
                        <X size={13} />
                      </button>
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                aria-label={t("Add a side tab")}
                aria-expanded={picking || !selected}
                onClick={() => setPicking((v) => !v)}
              >
                <Plus />
              </button>
              <button
                type="button"
                aria-label={t("Close side panel")}
                onClick={() => {
                  split.toggle();
                  document.getElementById("synora-split-toggle")?.focus();
                }}
              >
                <X />
              </button>
            </header>
            {(picking || !selected) && (
              <div className="side-chooser">
                <label>
                  {t("Choose a conversation or agent")}
                  <select
                    ref={chooser}
                    aria-label={t("Choose a conversation or agent")}
                    value=""
                    onKeyDown={(e) => {
                      if (e.key === "Escape") {
                        setPicking(false);
                        e.stopPropagation();
                      }
                    }}
                    onChange={(e) => {
                      const target = options
                        .flatMap((o) => o.targets)
                        .find((target) => sideKey(target) === e.target.value);
                      if (target) {
                        split.open(target);
                        setPicking(false);
                      }
                    }}
                  >
                    <option value="">
                      {t("Choose a conversation or agent")}
                    </option>
                    {options
                      .filter((o) => o.targets.length)
                      .map((o) => (
                        <optgroup key={o.label} label={t(o.label)}>
                          {o.targets.map((target) => (
                            <option
                              key={sideKey(target)}
                              value={sideKey(target)}
                              disabled={
                                value.tabs.length >= 12 &&
                                !value.tabs.some(
                                  (v) => sideKey(v) === sideKey(target),
                                )
                              }
                            >
                              {title(target)}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                  </select>
                </label>
              </div>
            )}
            {value.tabs.length >= 12 && (
              <p className="side-limit" role="status">
                {t("Close a tab before opening another (maximum 12).")}
              </p>
            )}
            {selected ? (
              <SideTranscript
                key={value.selected}
                target={selected}
                state={state}
                engine={engine}
                api={api}
                labelledBy={`side-tab-${value.tabs.indexOf(selected)}`}
              />
            ) : (
              <div className="side-empty">
                <Columns2 />
                <h2>{t("Read alongside your conversation")}</h2>
                <p>
                  {t(
                    "Choose an existing conversation, agent or worker task. Opening a tab does not start or interrupt work.",
                  )}
                </p>
              </div>
            )}
          </aside>
        </>
      )}
    </div>
  );
}

function SideTranscript({
  target,
  state,
  engine,
  api,
  labelledBy,
}: {
  target: SideTarget;
  state: AppState;
  engine: EngineSnapshot;
  api: DesktopAPI;
  labelledBy: string;
}) {
  const { t } = useI18n(messages);
  const sources = sideSources(state, engine);
  const agent =
    target.kind === "agent"
      ? sources.agents.find((a) => a.id === target.id)
      : undefined;
  const task =
    target.kind === "task"
      ? sources.tasks.find(
          (a) =>
            a.id === target.id && a.parentConversationId === target.parentId,
        )
      : undefined;
  const conversation =
    target.kind === "conversation"
      ? sources.conversations.find((c) => c.id === target.id)
      : undefined;
  const entries = reportedEntries(agent?.activity ?? task?.items ?? []);
  const timeline = conversationTimeline(conversation, engine);
  const result = agent?.result ?? task?.result;
  const simulated =
    agent?.simulated ??
    conversation?.messages.some((m) => m.simulated) ??
    false;
  const kind = simulated
    ? "Simulated"
    : agent || task || conversation?.binding
      ? "Live"
      : "Saved";
  const scroller = useRef<HTMLDivElement>(null),
    follow = useRef(true);
  const [atLatest, setAtLatest] = useState(true);
  useLayoutEffect(() => {
    if (follow.current && scroller.current)
      scroller.current.scrollTop = scroller.current.scrollHeight;
  }, [agent, task, conversation, engine.items]);
  return (
    <>
      <div className="side-reader-status">
        <span>{t("Read-only · updates automatically")}</span>
        <span className="badge">
          {t(kind)}
          {agent || task ? ` · ${agent?.status ?? task?.status}` : ""}
        </span>
      </div>
      <div
        id="side-reader-content"
        className="side-transcript"
        role="tabpanel"
        aria-labelledby={labelledBy}
        tabIndex={0}
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget;
          follow.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 48;
          setAtLatest(follow.current);
        }}
      >
        {(agent?.task || task?.task) && (
          <section className="side-assignment">
            <strong>{t("Reported task")}</strong>
            <p>{agent?.task ?? task?.task}</p>
          </section>
        )}
        {timeline.map((entry) =>
          entry.type === "tool" ? (
            <ToolActivity
              key={entry.id}
              item={entry.item}
              simulated={entry.simulated}
              compaction={conversation?.compactions?.find(
                (v) => v.id === entry.id,
              )}
            />
          ) : (
            <article
              className={`message ${entry.message.role}`}
              data-item-id={entry.id}
              key={entry.id}
            >
              <div className="message-label">
                {entry.message.role === "user"
                  ? t("You")
                  : (conversation?.defaults?.bot?.name ?? "Synora")}
              </div>
              <MessageText
                text={entry.message.text}
                assistant={entry.message.role === "assistant"}
              />
              <div className="image-attachments">
                {entry.message.imageIds?.map((id) => {
                  const image = conversation?.attachments?.find(
                    (v) => v.id === id,
                  );
                  return image && conversation ? (
                    <AttachedImage
                      key={id}
                      api={api}
                      conversationId={conversation.id}
                      image={image}
                    />
                  ) : (
                    <span role="status" key={id}>
                      {t("Image attachment unavailable")}
                    </span>
                  );
                })}
              </div>
            </article>
          ),
        )}
        {entries.map((entry) =>
          entry.kind === "activity" ? (
            <details
              className="tool-call"
              key={entry.id}
              data-item-id={entry.id}
            >
              <summary>{entry.text || t("Original activity details")}</summary>
              <pre>{JSON.stringify(entry.raw, null, 2)}</pre>
            </details>
          ) : (
            <article
              className={`message ${entry.kind === "user" ? "user" : "assistant"}`}
              key={entry.id}
              data-item-id={entry.id}
            >
              <div className="message-label">
                {entry.kind === "user" ? t("You") : (agent?.name ?? task?.name)}
              </div>
              <MessageText
                text={entry.text}
                assistant={entry.kind === "assistant"}
              />
              {entry.kind === "user" && (
                <details>
                  <summary>{t("Original activity details")}</summary>
                  <pre>{JSON.stringify(entry.raw, null, 2)}</pre>
                </details>
              )}
            </article>
          ),
        )}
        {result &&
          !entries.some((e) => e.kind === "assistant" && e.text === result) && (
            <section className="side-result">
              <strong>{t("Reported result")}</strong>
              <MessageText text={result} assistant />
            </section>
          )}
        {!entries.length && !timeline.length && !result && (
          <p>{t("No activity reported yet")}</p>
        )}
        {(agent?.metadataError || task?.error) && (
          <p role="status" className="form-error">
            {agent?.metadataError ?? task?.error}
          </p>
        )}
        <details className="side-identity">
          <summary>{t("Identity")}</summary>
          <pre>
            {JSON.stringify(
              agent
                ? {
                    threadId: agent.id,
                    parentThreadId: agent.parentId,
                    sessionId: agent.coreSessionId,
                    turnId: agent.turnId,
                    model: agent.model,
                  }
                : task
                  ? {
                      taskId: task.id,
                      parentConversationId: task.parentConversationId,
                      threadId: task.threadId,
                      sessionId: task.sessionId,
                      turnId: task.turnId,
                      callId: task.callId,
                    }
                  : {
                      conversationId: conversation?.id,
                      threadId: conversation?.binding?.threadId,
                      sessionId: conversation?.binding?.sessionId,
                    },
              null,
              2,
            )}
          </pre>
        </details>
      </div>
      {!atLatest && (
        <button
          type="button"
          className="side-latest"
          onClick={() => {
            follow.current = true;
            setAtLatest(true);
            if (scroller.current)
              scroller.current.scrollTop = scroller.current.scrollHeight;
          }}
        >
          {t("Latest activity")}
        </button>
      )}
    </>
  );
}
