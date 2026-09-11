import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { EngineSnapshot } from "../shared/contracts";
import { useI18n } from "./i18n";
import { messages } from "./locales/composer";

export function contextView(engine: EngineSnapshot, selected?: number | null) {
  const report = engine.usage;
  const usage = report?.value ?? engine.tokenUsage;
  const capacity = usage?.modelContextWindow ?? engine.selection?.context ?? selected ?? null;
  const lastCompaction = engine.compactions?.at(-1);
  const refreshing = lastCompaction?.status === "running" ||
    (lastCompaction?.status === "completed" && (!report || (lastCompaction.completedAt ?? 0) >= report.observedAt));
  const used = !refreshing ? usage?.last.totalTokens ?? null : null;
  const percent = used !== null && capacity && capacity > 0 ? 100 * used / capacity : null;
  return { report, usage, capacity, used, percent, refreshing, lastCompaction };
}

/** Context occupancy is the latest Core report, never cumulative consumption or
 * a character/token estimate. Portal keeps hover details outside clipped footer. */
export function ContextUsage({ engine, selected }: { engine: EngineSnapshot; selected?: number | null }) {
  const { t, number, locale } = useI18n(messages);
  const { usage, report, capacity, used, percent, refreshing, lastCompaction } = contextView(engine, selected);
  const [open, setOpen] = useState(false), [position, setPosition] = useState<CSSProperties>({ top: 8, left: 8 });
  const button = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const dismissed = useRef({ pointer: false, focus: false });
  const id = useId();
  const show = () => { clearTimeout(timer.current); setOpen(true); };
  const hideLater = () => { clearTimeout(timer.current); timer.current = setTimeout(() => setOpen(false), 120); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = button.current!, p = panel.current!;
      const rect = b.getBoundingClientRect(), bounds = p.getBoundingClientRect();
      // Keep the whole control row clear, including when translated controls wrap.
      const controls = b.closest(".composer-controls")?.getBoundingClientRect() ?? rect;
      const above = Math.max(0, controls.top - 18), below = Math.max(0, innerHeight - controls.bottom - 18);
      const placeAbove = above >= p.scrollHeight + 2 || above >= below;
      setPosition({ left: Math.max(8, Math.min(innerWidth - bounds.width - 8, rect.right - bounds.width)),
        maxHeight: placeAbove ? above : below,
        ...(placeAbove ? { bottom: innerHeight - controls.top + 10 } : { top: controls.bottom + 10 }) });
    };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") {
      clearTimeout(timer.current);
      // A disappearing portal can generate a fresh pointer-enter on its anchor.
      // Suppress that modality until leave; a new keyboard focus still works.
      dismissed.current = { pointer: true, focus: document.activeElement === button.current };
      setOpen(false);
    } };
    const outside = (e: PointerEvent) => { if (!button.current?.contains(e.target as Node) && !panel.current?.contains(e.target as Node)) setOpen(false); };
    place();
    window.addEventListener("resize", place); window.addEventListener("scroll", place, true);
    document.addEventListener("keydown", key); document.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("resize", place); window.removeEventListener("scroll", place, true);
      document.removeEventListener("keydown", key); document.removeEventListener("pointerdown", outside); };
  }, [open, used, capacity, refreshing, locale]);
  const measured = (value: number | null | undefined) => value == null ? "—" : number(value);
  const active = ["running", "waiting"].includes(engine.status);
  const currentTurn = report && (!active || report.turnId === engine.turnId) ? report.turn : undefined;
  const percentText = percent === null ? t("Not measured yet") : t("{percent}% used", { percent: number(Math.round(percent)) });
  return <>
    <button ref={button} type="button" className={`context-ring ${refreshing ? "compacting" : ""}`}
      aria-label={t("Context usage: {usage}", { usage: percentText })} aria-describedby={open ? id : undefined}
      onPointerEnter={() => { if (!dismissed.current.pointer) show(); }}
      onPointerLeave={() => { dismissed.current.pointer = false; hideLater(); }}
      onFocus={() => { if (!dismissed.current.focus) show(); }}
      onBlur={() => { dismissed.current.focus = false; hideLater(); }}
      onClick={() => { dismissed.current = { pointer: false, focus: false }; show(); }}>
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <circle className="context-ring-track" cx="16" cy="16" r="11" />
        {percent !== null && <circle className="context-ring-value" cx="16" cy="16" r="11" pathLength="100"
          strokeDasharray={`${Math.min(100, percent)} 100`} transform="rotate(-90 16 16)" />}
        {percent === null && <text x="16" y="20" textAnchor="middle">?</text>}
      </svg>
    </button>
    {open && createPortal(<div ref={panel} id={id} role="tooltip" className="context-usage-popover"
      style={position} onPointerEnter={() => { if (!dismissed.current.pointer) show(); }}
      onPointerLeave={() => { dismissed.current.pointer = false; hideLater(); }}>
      <div className="context-popover-heading">{t("Context window")}</div>
      <strong className="context-popover-percent">{refreshing ? t("Refreshing after compaction…") : percentText}</strong>
      <div className="context-popover-amount">{t("{used} / {capacity} tokens used", { used: measured(used), capacity: measured(capacity) })}</div>
      <p className="context-popover-note">{usage ? t("Latest Core measurement — not the cumulative token total.") :
        active ? t("Waiting for the first token-usage event from Core.") : t("No usage measurement yet. The selected capacity is not occupied context.")}</p>
      <dl>
        <dt>{t("Remaining in window")}</dt><dd>{used !== null && capacity ? number(Math.max(0, capacity - used)) : "—"}</dd>
        <dt>{t(active ? "Current turn" : "Last turn")}</dt><dd>{t("{count} tokens", { count: measured(currentTurn?.totalTokens) })}</dd>
        <dt>{t("Conversation total")}</dt><dd>{t("{count} tokens", { count: measured(usage?.total.totalTokens) })}</dd>
        <dt>{t("Total input / output")}</dt><dd>{measured(usage?.total.inputTokens)} / {measured(usage?.total.outputTokens)}</dd>
        <dt>{t("Reasoning (within output)")}</dt><dd>{measured(usage?.total.reasoningOutputTokens)}</dd>
        <dt>{t("Cached input (within input)")}</dt><dd>{measured(usage?.total.cachedInputTokens)}</dd>
        <dt>{t("Auto-compaction")}</dt><dd>{t("Managed by Core")}</dd>
        <dt>{t("Last compaction")}</dt><dd>{lastCompaction?.status ?? t("None reported")}</dd>
      </dl>
      <p className="context-popover-note">{t("Updates when Core reports usage. No character-based token estimates. Automatic compaction can occur before the window is full.")}</p>
    </div>, document.body)}
  </>;
}
