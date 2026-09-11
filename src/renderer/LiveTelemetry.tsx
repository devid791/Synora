import { useEffect, useState, type ReactNode } from "react";
import { Activity, Cpu, SlidersHorizontal, X } from "lucide-react";
import type { DesktopAPI, EngineSnapshot } from "../shared/contracts";
import type { BackendStatus } from "../shared/backend-status";
import { useI18n } from "./i18n";
import { messages as composerMessages } from "./locales/composer";
import { messages as statusMessages } from "./locales/status-bar";
import { LiveGpuStatus } from "./LiveGpuStatus";
import { Modal } from "./Modal";
import { sampleStale } from "../shared/resource-telemetry";

const messages = { ...composerMessages, ...statusMessages };
const statusLabels: Record<EngineSnapshot["status"], string> = {
  idle: "Ready",
  running: "Working",
  waiting: "Awaiting approval",
  disconnected: "Disconnected",
  completed: "Completed",
  failed: "Failed",
  interrupted: "Interrupted",
};

/** Stream-driven turn counters and independently polled backend state. Historical
 * GPU samples are deliberately not relabelled as instantaneous GPU measurements. */
export function LiveTelemetry({
  api,
  engine,
  axiom,
  connection,
  diagnostics,
  onOverlayChange,
}: {
  api: Pick<DesktopAPI, "backendStatus">;
  engine: EngineSnapshot;
  axiom: boolean;
  connection?: ReactNode;
  diagnostics?: ReactNode;
  onOverlayChange?: (open: boolean) => void;
}) {
  const { t, number, locale } = useI18n(messages);
  const fixed = (value: number, digits: number) =>
    new Intl.NumberFormat(locale === "pt" ? "pt-PT" : locale, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  const [now, setNow] = useState(Date.now()),
    [backend, setBackend] = useState<BackendStatus | null>(null);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    onOverlayChange?.(expanded);
    return () => onOverlayChange?.(false);
  }, [expanded, onOverlayChange]);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (!axiom) return;
    let stopped = false,
      pending = false;
    const poll = async () => {
      if (pending || stopped) return;
      pending = true;
      try {
        const r = await api.backendStatus();
        if (!r.ok) throw Error(r.error.message);
        if (!stopped) {
          setBackend(r.value);
          setError("");
        }
      } catch (e) {
        if (!stopped) setError(e instanceof Error ? e.message : String(e));
      } finally {
        pending = false;
      }
    };
    void poll();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, 2000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [api, axiom]);
  const kv = backend?.mode === "live" ? backend.kv : undefined;
  const sample =
    backend?.mode === "live" && backend.resources.state === "available"
      ? backend.resources.data.resources_after
      : undefined;
  const active = ["running", "waiting"].includes(engine.status);
  const elapsed = engine.startedAt !== undefined && (active || engine.completedAt !== undefined)
    ? Math.max(0, (engine.completedAt ?? now) - engine.startedAt) / 1000
    : null;
  const textCharacters = engine.items.reduce(
    (n, i) => n + (i.type === "agentMessage" ? i.text.length : 0),
    0,
  );
  const summary = engine.usage?.value ?? engine.tokenUsage;
  const usage = summary?.last;
  const turn =
    engine.usage && (!active || engine.usage.turnId === engine.turnId)
      ? engine.usage.turn
      : undefined;
  const last = engine.backendRequests?.at(-1);
  const agents = engine.agents.filter((a) => a.status === "running").length;
  const activityLabel = t(statusLabels[engine.status]);
  return (
    <div
      className="live-telemetry live-telemetry-summary"
      aria-label={t("Live session telemetry")}
    >
      {connection}
      <div className="status-activity" data-status={engine.status}>
        <Activity size={14} aria-hidden="true" />
        <span
          className="status-activity-label"
          role="status"
          title={activityLabel}
        >
          {activityLabel}
        </span>
        {elapsed !== null && (
          <span className="status-elapsed">{fixed(elapsed, 1)}s</span>
        )}
        {agents > 0 && (
          <span
            className="status-agents"
            title={t("Agents {count} active", { count: number(agents) })}
          >
            {t("Agents {count} active", { count: number(agents) })}
          </span>
        )}
      </div>
      {axiom && (
        <div className="status-gpu">
          <Cpu size={14} aria-hidden="true" />
          <LiveGpuStatus
            backend={backend}
            engine={engine}
            now={now}
            error={error}
            compact
          />
        </div>
      )}
      <button
        type="button"
        className="status-details-button"
        aria-label={t("Telemetry details")}
        title={t("Telemetry details")}
        aria-haspopup="dialog"
        aria-expanded={expanded}
        onClick={() => setExpanded(true)}
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span>{t("Details")}</span>
      </button>
      {expanded && (
        <Modal
          label={t("Telemetry details")}
          onDismiss={() => setExpanded(false)}
        >
          <div className="telemetry-details">
            <header>
              <h2>{t("Telemetry details")}</h2>
              <button
                type="button"
                className="icon"
                aria-label={t("Close")}
                onClick={() => setExpanded(false)}
              >
                <X size={18} />
              </button>
            </header>
            <div className="telemetry-details-body">
              <section>
                <h3>{t("Conversation activity")}</h3>
                <div className="telemetry-values">
                  <span data-turn-detail>
                    {activityLabel}
                    {elapsed !== null ? ` · ${fixed(elapsed, 1)}s` : ""}
                  </span>
                  <span
                    title={t(
                      "Time to first displayed text, measured from the Core turn-start event",
                    )}
                  >
                    {engine.firstDeltaAt && engine.startedAt
                      ? t("First text {seconds}s", {
                          seconds: fixed(
                            (engine.firstDeltaAt - engine.startedAt) / 1000,
                            2,
                          ),
                        })
                      : active
                        ? t("Waiting for first text…")
                        : t("First text —")}
                  </span>
                  <span
                    title={t(
                      "Actual received text length in UTF-16 code units; not estimated tokens",
                    )}
                  >
                    {t("Text {count} chars", { count: number(textCharacters) })}
                  </span>
                  <span
                    title={t(
                      "Exact usage as last reported by Core; it may arrive at the end of generation",
                    )}
                  >
                    {usage
                      ? t(
                          "Tokens {input} in / {output} out · reasoning {reasoning}",
                          {
                            input: number(usage.inputTokens),
                            output: number(usage.outputTokens),
                            reasoning: number(usage.reasoningOutputTokens),
                          },
                        )
                      : t(
                          active
                            ? "Tokens: awaiting Core"
                            : "Tokens: no request measured yet",
                        )}
                  </span>
                  {summary && (
                    <span
                      title={t(
                        "Cumulative reported consumption. Input includes cached input; reasoning is already part of output.",
                      )}
                    >
                      {t("Conversation {count} tokens", {
                        count: number(summary.total.totalTokens),
                      })}
                    </span>
                  )}
                  {turn && (
                    <span
                      title={t(
                        "Consumption during this user turn, including its model/tool cycles; not occupied context.",
                      )}
                    >
                      {t(
                        active
                          ? "Current turn {count} tokens"
                          : "Last turn {count} tokens",
                        { count: number(turn.totalTokens) },
                      )}
                    </span>
                  )}
                  {last && (
                    <span
                      title={t(
                        "Completed Axiom request only, not an instantaneous or sustained rate",
                      )}
                    >
                      {t("Last decode {rate} tok/s", {
                        rate: fixed(last.decodeTokensPerSecond, 1),
                      })}
                    </span>
                  )}
                  <span>
                    {t("Agents {count} active", { count: number(agents) })}
                  </span>
                </div>
              </section>
              {axiom && (
                <>
                  <section>
                    <h3>{t("Live backend")}</h3>
                    <div className="telemetry-values">
                      <LiveGpuStatus
                        backend={backend}
                        engine={engine}
                        now={now}
                        error={error}
                      />
                      {kv?.state === "available" && (
                        <span
                          title={t(
                            "Backend-wide KV, not necessarily this thread. Sample {time}",
                            {
                              time: new Date(kv.observedAt).toLocaleTimeString(
                                locale === "pt" ? "pt-PT" : locale,
                              ),
                            },
                          )}
                        >
                          {t("KV {tokens} tok · {pages} hot pages", {
                            tokens: number(kv.data.committed_tokens),
                            pages: number(kv.data.hot_pages),
                          })}
                          {sampleStale(kv.observedAt, now) || error
                            ? ` (${t("stale")})`
                            : ""}
                        </span>
                      )}
                    </div>
                  </section>
                  <section>
                    <h3>{t("Last request sample")}</h3>
                    <div className="telemetry-values">
                      <span
                        title={t(
                          "VRAM from the last completed Axiom request; live host sensors are shown separately.",
                        )}
                      >
                        VRAM{" "}
                        {sample?.gpu_available
                          ? t("{used} / {total} GiB (last request)", {
                              used: fixed(sample.gpu_used_bytes / 1024 ** 3, 1),
                              total: fixed(
                                sample.gpu_total_bytes / 1024 ** 3,
                                1,
                              ),
                            })
                          : t("live sample unavailable")}
                      </span>
                    </div>
                  </section>
                </>
              )}
              {diagnostics}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
