import { useLayoutEffect, useRef } from "react";

export type NativeBrowserViewport = {
  id: string;
  rect: { x: number; y: number; width: number; height: number };
};

/** The main renderer owns the single native-view layout operation. This slot
 * reports geometry only; it never captures frames or proxies user input. */
export function NativeBrowserSurface({
  id, blocked, label, onViewport,
}: {
  id: string;
  blocked: boolean;
  label: string;
  onViewport: (viewport: NativeBrowserViewport | null) => void;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = surface.current;
    let frame = 0, previous = "", live = true;
    const publish = (value: NativeBrowserViewport | null) => {
      const key = JSON.stringify(value);
      if (key !== previous) { previous = key; onViewport(value); }
    };
    const measure = () => {
      frame = 0;
      if (!live || !element || blocked) { publish(null); return; }
      const r = element.getBoundingClientRect();
      let visible = r.width >= 16 && r.height >= 16 && r.left >= 0 && r.top >= 0 &&
        r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
      // Native child views sit above DOM content. Hide when a modal/menu or
      // clipping ancestor covers the slot, rather than cover consent or Stop.
      for (let parent = element.parentElement; visible && parent; parent = parent.parentElement) {
        const style = getComputedStyle(parent), bounds = parent.getBoundingClientRect();
        if (/(auto|scroll|hidden|clip)/.test(style.overflowX))
          visible &&= r.left >= bounds.left - 0.5 && r.right <= bounds.right + 0.5;
        if (/(auto|scroll|hidden|clip)/.test(style.overflowY))
          visible &&= r.top >= bounds.top - 0.5 && r.bottom <= bounds.bottom + 0.5;
      }
      for (const [x, y] of [[r.left + 1, r.top + 1], [r.right - 1, r.top + 1],
        [r.left + 1, r.bottom - 1], [r.right - 1, r.bottom - 1], [r.left + r.width / 2, r.top + r.height / 2]]) {
        const hit = document.elementFromPoint(x, y);
        if (!hit || (hit !== element && !element.contains(hit))) visible = false;
      }
      // Small menus can overlap between the sample points. Top-layer popovers
      // also open without attribute mutations, so track them explicitly.
      for (const overlay of document.querySelectorAll<HTMLElement>(
        'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="tooltip"], [popover]:popover-open',
      )) {
        if (overlay.contains(element) || element.contains(overlay) || !overlay.checkVisibility()) continue;
        const b = overlay.getBoundingClientRect();
        if (b.width && b.height && b.left < r.right && b.right > r.left && b.top < r.bottom && b.bottom > r.top)
          visible = false;
      }
      publish(visible ? { id, rect: { x: r.x, y: r.y, width: r.width, height: r.height } } : null);
    };
    const schedule = () => { if (!frame && live) frame = requestAnimationFrame(measure); };
    const resize = new ResizeObserver(schedule);
    if (element) resize.observe(element);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.body, { subtree: true, childList: true, attributes: true });
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    document.addEventListener("toggle", schedule, true);
    document.addEventListener("transitionend", schedule, true);
    measure();
    return () => {
      live = false; cancelAnimationFrame(frame); resize.disconnect(); mutation.disconnect();
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      document.removeEventListener("toggle", schedule, true);
      document.removeEventListener("transitionend", schedule, true);
      onViewport(null);
    };
  }, [id, blocked, onViewport]);
  return <div className="native-browser-surface" ref={surface} role="region" aria-label={label} />;
}
