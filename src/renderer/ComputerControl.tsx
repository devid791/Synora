import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Monitor,
  Square,
  X,
  Globe,
  ShieldCheck,
  Maximize2,
} from "lucide-react";
import type { DesktopAPI, Result } from "../shared/contracts";
import type { ControlState } from "../shared/computer-use";
import { useI18n } from "./i18n";
import { messages } from "./locales/computer-use";
import { RemoteBrowser } from "./RemoteBrowser";
import { NativeBrowserSurface, type NativeBrowserViewport } from "./NativeBrowserSurface";
import "./computer-control.css";

export function ComputerControl({
  api,
  conversationId,
  busy,
  open,
  onOpenChange,
  onOpenBrowser,
  browserPresentation,
  browserBlocked = false,
  onBrowserViewport,
  onBrowserTargetChange,
}: {
  api: DesktopAPI;
  conversationId?: string;
  busy: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenBrowser: (id: string) => void;
  browserPresentation?: "native-view" | "remote-frame";
  browserBlocked?: boolean;
  onBrowserViewport?: (viewport: NativeBrowserViewport | null) => void;
  onBrowserTargetChange?: (id: string | null) => void;
}) {
  const { t } = useI18n(messages);
  const setOpen = onOpenChange;
  const [state, setState] = useState<ControlState | null>(null),
    [error, setError] = useState(""),
    [saving, setSaving] = useState(false);
  const [paneWidth, setPaneWidth] = useState<number | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const selectedConversation = useRef(conversationId);
  selectedConversation.current = conversationId;
  const target = anchor.current?.closest<HTMLElement>(".main");
  const maxWidth = Math.max(
    360,
    window.innerWidth - (target?.getBoundingClientRect().left ?? 232) - 480,
  );
  const width = Math.min(
    maxWidth,
    paneWidth ?? Math.min(600, Math.max(360, window.innerWidth * 0.35)),
  );
  const resize = (value: number) =>
    setPaneWidth(Math.round(Math.max(360, Math.min(maxWidth, value))));
  useEffect(() => {
    if (!target) return;
    target.style.setProperty("--control-pane-width", `${width}px`);
    return () => {
      target.style.removeProperty("--control-pane-width");
    };
  }, [target, width]);
  const unwrap = (r: Result<ControlState>) => {
    if (!r.ok) throw Error(r.error.message);
    setState(r.value);
    return r.value;
  };
  useEffect(() => {
    if (!api.controlStatus) return;
    let live = true;
    void Promise.resolve()
      .then(() => api.controlStatus())
      .then((r) => {
        if (live) unwrap(r);
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    const off = api.onEvent((e) => {
      if (e.kind === "browser") {
        setState((old) => {
          if (old?.preview?.kind !== "browser") return old;
          const tab = e.tabs.find((tab) => tab.id === old.preview!.id);
          return {
            ...old,
            preview: tab
              ? { ...old.preview, title: tab.title, url: tab.url }
              : null,
          };
        });
      }
      if (e.kind === "control") {
        setState(e.state);
        if ((e.state.pending && e.state.pending.conversationId === selectedConversation.current) ||
            (e.state.activity.at(-1)?.status === "running" && e.state.activity.at(-1)?.conversationId === selectedConversation.current))
          setOpen(true);
      }
    });
    return () => {
      live = false;
      off();
    };
  }, [api]);
  const run = async (fn: () => Promise<Result<ControlState>>) => {
    setError("");
    try {
      unwrap(await fn());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };
  const granted =
    state?.grant && state.grant.conversationId === conversationId
      ? state.grant
      : null;
  const preview = granted ? state?.preview : null;
  const pending = state?.pending && state.pending.conversationId === conversationId ? state.pending : null;
  const activity = state?.activity.filter(a => a.conversationId === conversationId) ?? [];
  const browserTarget = preview?.kind === "browser" ? preview.id : null;
  useLayoutEffect(() => {
    onBrowserTargetChange?.(browserTarget);
    return () => onBrowserTargetChange?.(null);
  }, [browserTarget, onBrowserTargetChange]);
  const report = useCallback(
    (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    [],
  );
  const configure = async (kind: "browser" | "computer", enabled: boolean) => {
    if (!conversationId || saving) return;
    setSaving(true);
    try {
      await run(() =>
        api.controlConfigure({
          conversationId,
          browser: granted?.browser ?? false,
          computer: granted?.computer ?? false,
          [kind]: enabled,
        }),
      );
    } finally {
      setSaving(false);
    }
  };
  const panel = open && (
    <aside
      className="computer-control-panel"
      aria-label={t("Computer & browser")}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          setOpen(false);
          anchor.current?.focus();
        }
      }}
    >
      <div
        className="control-resize"
        role="separator"
        aria-label={t("Resize browser panel")}
        aria-orientation="vertical"
        aria-valuemin={360}
        aria-valuemax={Math.round(maxWidth)}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        onPointerDown={(e) => {
          e.preventDefault();
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId))
            resize(window.innerWidth - e.clientX);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
            e.preventDefault();
            resize(width + (e.key === "ArrowLeft" ? 32 : -32));
          }
        }}
      />
      <header>
        <strong>
          <Monitor size={16} /> {t("Computer & browser")}
        </strong>
        {state?.grant && (
          <button
            className="control-stop"
            onClick={() => void run(() => api.controlStop())}
          >
            <Square size={13} />
            {t("Stop control")}
          </button>
        )}
        <button aria-label={t("Close panel")} onClick={() => setOpen(false)}>
          <X size={16} />
        </button>
      </header>
      <div className="computer-control-body">
        <details className="control-grants" open={!preview}>
          <summary>
            <ShieldCheck size={15} /> {t("Allow for this conversation")}
          </summary>
          <label>
            <input
              type="checkbox"
              checked={granted?.browser ?? false}
              disabled={
                !conversationId || !state?.available.browser || busy || saving
              }
              onChange={(e) => void configure("browser", e.target.checked)}
            />
            <Globe size={15} />
            {t("Internal browser")}
          </label>
          <label>
            <input
              type="checkbox"
              checked={granted?.computer ?? false}
              disabled={
                !conversationId || !state?.available.computer || busy || saving
              }
              onChange={(e) => void configure("computer", e.target.checked)}
            />
            <Monitor size={15} />
            {t("Desktop applications")}
          </label>
          <p>
            {t(
              "Screens and page content are sent to the selected model. Access expires when you stop control or close Synora.",
            )}
          </p>
          {!state?.available.computer && state?.available.reason && (
            <p className="muted">{state.available.reason}</p>
          )}
        </details>
        {pending && (
          <section
            className="control-consent"
            role="alert"
            aria-label={t(pending.title)}
          >
            <strong>{t(pending.title)}</strong>
            <pre>{pending.details}</pre>
            <div>
              <button
                onClick={() =>
                  void run(() => api.controlApprove(pending.id, false))
                }
              >
                {t("Decline")}
              </button>
              <button
                className="primary"
                onClick={() =>
                  void run(() => api.controlApprove(pending.id, true))
                }
              >
                {t(
                  pending.title === "Allow control action"
                    ? "Allow once"
                    : "Allow for this conversation",
                )}
              </button>
            </div>
          </section>
        )}
        {error && (
          <p role="alert" className="form-error">
            {error}
          </p>
        )}
        {preview ? (
          <section className="control-preview">
            {preview.kind === "browser" && (
              <button
                className="control-expand"
                onClick={() => {
                  onOpenBrowser(preview.id);
                  setOpen(false);
                }}
              >
                <Maximize2 size={13} />
                {t("Open full browser")}
              </button>
            )}
            <div className="control-address">{preview.title}</div>
            {preview.url && (
              <div className="control-url" title={preview.url}>
                {preview.url}
              </div>
            )}
            {preview.kind === "browser" ? (
              browserPresentation === "native-view" && onBrowserViewport ? (
                <NativeBrowserSurface id={preview.id}
                  blocked={browserBlocked || !!pending || !granted?.browser}
                  label={t("Live browser page")}
                  onViewport={onBrowserViewport} />
              ) : <RemoteBrowser id={preview.id} api={api} report={report} />
            ) : (
              <>
                <img
                  src={preview.frame?.dataURL}
                  alt={t("Last observed window")}
                />
                <small>
                  {t("Last observed window")} ·{" "}
                  {new Date(preview.at).toLocaleTimeString()}
                </small>
              </>
            )}
          </section>
        ) : (
          <section className="control-empty">
            <Monitor size={28} />
            <strong>{t("No screen shared yet")}</strong>
            <p>
              {t(
                "Ask the model to use the internal browser or an open application. Its actual observations and actions appear here.",
              )}
            </p>
          </section>
        )}
        {!!activity.length && (
          <details className="control-activity" open={!preview}>
            <summary>{t("Activity")}</summary>
            {activity
              .slice(-12)
              .reverse()
              .map((a) => (
                <div key={a.id}>
                  <span className={`control-state control-${a.status}`} />
                  <strong title={a.tool}>
                    {t(activityLabels[a.tool] ?? a.tool)}
                  </strong>
                  <small>
                    {t(
                      a.status === "running"
                        ? "In progress"
                        : a.status === "failed"
                          ? "Not completed"
                          : "Completed",
                    )}{" "}
                    · {new Date(a.at).toLocaleTimeString()}
                  </small>
                  <p>{a.target}</p>
                  {a.error && <p className="form-error">{a.error}</p>}
                </div>
              ))}
          </details>
        )}
      </div>
    </aside>
  );
  return (
    <>
      <button
        ref={anchor}
        aria-label={t("Computer & browser")}
        title={t("Computer & browser")}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <Monitor size={17} />
      </button>
      {state?.grant && (
        <button
          className="control-stop"
          title="Ctrl/Cmd+Shift+F12"
          onClick={() => void run(() => api.controlStop())}
        >
          <Square size={13} />
          {t("Stop control")}
        </button>
      )}
      {panel && target ? createPortal(panel, target) : null}
    </>
  );
}
const activityLabels: Record<string, string> = {
  control_status: "Check control availability",
  browser_tabs: "List browser tabs",
  browser_open: "Open website",
  browser_snapshot: "Read webpage",
  browser_action: "Use webpage",
  computer_windows: "List applications",
  computer_snapshot: "Observe application",
  computer_action: "Use application",
};
