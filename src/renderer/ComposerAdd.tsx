import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "./i18n";
import { messages } from "./locales/composer";

/** Native popover escapes composer clipping and handles outside click / Escape. */
export function ComposerAdd({ busy, children, plugins, models }: {
  busy: boolean; children: ReactNode; plugins: () => void; models: () => void;
}) {
  const { t } = useI18n(messages);
  const anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const position = () => {
    const button = anchor.current, popup = panel.current;
    if (!button || !popup) return;
    const r = button.getBoundingClientRect();
    popup.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - popup.offsetWidth - 8))}px`;
    popup.style.top = `${Math.max(8, r.top - popup.offsetHeight - 8)}px`;
  };
  useEffect(() => {
    window.addEventListener("resize", position);
    return () => window.removeEventListener("resize", position);
  }, []);
  const go = (action: () => void) => { panel.current?.hidePopover(); action(); };
  return <>
    <button ref={anchor} className="composer-add" type="button" aria-label={t("Add to conversation")}
      disabled={busy} title={t("Attachments and tools")} onClick={() => {
        if (panel.current?.matches(":popover-open")) panel.current.hidePopover();
        else { panel.current?.showPopover(); position(); panel.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus(); }
      }}>+</button>
    <div ref={panel} popover="auto" className="composer-add-menu" aria-label={t("Attachments and tools")}>
      <strong>{t("Add to conversation")}</strong>
      {children}
      <button type="button" onClick={() => go(plugins)}>{t("Plugins & connectors")}</button>
      <button type="button" onClick={() => go(models)}>{t("Models & accounts")}</button>
      <small>{t("Vision reads images. Creating images requires a connected image-generation tool; vision alone does not enable it.")}</small>
    </div>
  </>;
}
