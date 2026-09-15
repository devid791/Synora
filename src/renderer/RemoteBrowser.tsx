import { useEffect, useRef, useState } from "react";
import { useI18n, type Messages } from "./i18n";
import { messages } from "./locales/orchestration";
import type {
  BrowserFrame,
  BrowserInput,
  DesktopAPI,
} from "../shared/contracts";

export function RemoteBrowser({
  api,
  id,
  report,
}: {
  api: DesktopAPI;
  id: string;
  report: (error: unknown) => void;
}) {
  const { t } = useI18n(messages satisfies Messages);
  const [frame, setFrame] = useState<BrowserFrame | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const queue = useRef(Promise.resolve());
  useEffect(() => {
    let active = true,
      timer: ReturnType<typeof setTimeout>;
    setFrame(null);
    setFrameError(null);
    const poll = async () => {
      try {
        const result = await api.browserFrame(id);
        if (active) {
          if (result.ok) { setFrame(result.value); setFrameError(null); }
          else setFrameError(result.error.message);
        }
      } catch (e) {
        if (active) setFrameError(e instanceof Error ? e.message : String(e));
      } finally {
        if (active) timer = setTimeout(() => void poll(), 350);
      }
    };
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [api, id, report]);
  const input = (value: BrowserInput) => {
    if (frameError) return;
    queue.current = queue.current
      .then(async () => {
        const result = await api.browserInput(id, value);
        if (!result.ok) throw new Error(result.error.message);
      })
      .catch(report);
  };
  const point = (x: number, y: number, element: HTMLElement) => {
    const r = element.getBoundingClientRect();
    return {
      x: Math.max(
        0,
        Math.min(frame!.width - 1, ((x - r.left) * frame!.width) / r.width),
      ),
      y: Math.max(
        0,
        Math.min(frame!.height - 1, ((y - r.top) * frame!.height) / r.height),
      ),
    };
  };
  if (frameError)
    return <p className="muted" role="status" title={frameError}>{t("Browser preview unavailable. Retrying…")}</p>;
  if (!frame)
    return <p className="muted">{t("Connecting to the isolated browser…")}</p>;
  return (
    <img
      className="remote-browser"
      alt={t("Interactive isolated browser page")}
      src={frame.dataURL}
      draggable={false}
      tabIndex={0}
      onClick={(e) => {
        e.currentTarget.focus();
        input({
          type: "click",
          ...point(e.clientX, e.clientY, e.currentTarget),
          button: "left",
        });
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        input({
          type: "click",
          ...point(e.clientX, e.clientY, e.currentTarget),
          button: "right",
        });
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.currentTarget.blur();
          return;
        }
        if (["Shift", "Control", "Meta", "Alt"].includes(e.key)) return;
        // Let the local browser deliver the paste event, not a backend clipboard.
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "v") return;
        e.preventDefault();
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey)
          input({ type: "text", text: e.key });
        else
          input({
            type: "key",
            key: [
              e.ctrlKey ? "Control" : null,
              e.metaKey ? "Meta" : null,
              e.altKey ? "Alt" : null,
              e.shiftKey ? "Shift" : null,
              e.key === " " ? "Space" : e.key,
            ]
              .filter(Boolean)
              .join("+"),
          });
      }}
      onPaste={(e) => {
        e.preventDefault();
        input({ type: "text", text: e.clipboardData.getData("text") });
      }}
      onWheel={(e) =>
        input({
          type: "scroll",
          ...point(e.clientX, e.clientY, e.currentTarget),
          deltaX: Math.max(-10000, Math.min(10000, e.deltaX)),
          deltaY: Math.max(-10000, Math.min(10000, e.deltaY)),
        })
      }
    />
  );
}
