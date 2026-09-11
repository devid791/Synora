import { useEffect, useRef, useState } from "react";
import type { DesktopAPI } from "../shared/contracts";
import type { BackendStatus as Status } from "../shared/backend-status";
import { useI18n } from "./i18n";
import { messages } from "./locales/composer";

export function BackendStatus({
  api,
  onObservation,
}: {
  api: Pick<DesktopAPI, "backendStatus">;
  onObservation?: (status: Status | null, error: string) => void;
}) {
  const { t, number, locale } = useI18n(messages);
  const gib = (value: number) => `${new Intl.NumberFormat(locale === "pt" ? "pt-PT" : locale,
    { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value / 1024 ** 3)} GiB`;
  const date = (value: number) => new Date(value).toLocaleString(locale === "pt" ? "pt-PT" : locale);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const refresh = useRef<() => void>(() => {});
  useEffect(() => {
    let mounted = true,
      busy = false;
    const poll = async () => {
      if (busy) return;
      busy = true;
      if (mounted) setPending(true);
      try {
        const result = await api.backendStatus();
        if (!result.ok) throw new Error(result.error.message);
        if (mounted) {
          setStatus(result.value);
          setError("");
          onObservation?.(result.value, "");
        }
      } catch (e) {
        if (mounted) {
          setStatus(null);
          setError(e instanceof Error ? e.message : String(e));
          onObservation?.(null, e instanceof Error ? e.message : String(e));
        }
      } finally {
        busy = false;
        if (mounted) setPending(false);
      }
    };
    refresh.current = () => void poll();
    void poll();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void poll();
    }, 2000);
    return () => {
      mounted = false;
      clearInterval(timer);
      refresh.current = () => {};
    };
  }, [api, onObservation]);
  const runtime = status?.mode === "live" ? status.runtime : null;
  const usage = status?.mode === "live" ? status.resources : null;
  const r = runtime?.state === "available" ? runtime.data : null;
  const u = usage?.state === "available" ? usage.data : null;
  const memory = u?.resources_after;
  const reason = status?.mode === "inactive" ? status.reason : "";
  // Only these known Synora notices are localized; unknown backend detail stays verbatim.
  const providerNotice = /^This (.+) provider has no Axiom GPU or KV telemetry\. Per-turn usage is reported separately by Core\.$/.exec(reason);
  const inactiveReason = providerNotice
    ? t("This {provider} provider has no Axiom GPU or KV telemetry. Per-turn usage is reported separately by Core.", { provider: providerNotice[1] })
    : reason === "Select a live Axiom provider in Settings. The simulator does not query a backend."
      ? t("Select a live Axiom provider in Settings. The simulator does not query a backend.") : reason;
  return (
    <article className="card backend-status">
      <h2>{t("Axiom backend observation")}</h2>
      <p>
        {t("Independent read-only status polling. A slow or unavailable status endpoint does not mark inference offline.")}
      </p>
      <button onClick={() => refresh.current()} disabled={pending}>
        {t(pending ? "Reading status…" : "Refresh backend status")}
      </button>
      {error && <p role="alert">{error}</p>}
      {!status && !error && <p>{t("Waiting for the first backend observation.")}</p>}
      {status?.mode === "inactive" && <p>{t("Backend inactive: {reason}", { reason: inactiveReason })}</p>}
      {status?.mode === "live" && (
        <>
          <p className="mono">{status.endpoint}</p>
          {runtime?.state === "unavailable" && (
            <p role="status">
              {t("Runtime status unavailable")} · {runtime.code}: {runtime.message}
            </p>
          )}
          {r && (
            <dl>
              <dt>{t("Model / backend")}</dt>
              <dd>
                {r.model} / {r.backend}
              </dd>
              <dt>{t("Model loaded")}</dt>
              <dd>{t(r.loaded ? "Yes" : "No")}</dd>
              <dt>{t("Generation")}</dt>
              <dd>{t("{state} (at observation)", { state: t(r.generation_busy ? "Busy" : "Idle") })}</dd>
              <dt>{t("Active session / request")}</dt>
              <dd className="mono">
                {r.active_session_id ?? t("None")} /{" "}
                {r.active_request_sequence ?? t("None")}
              </dd>
              <dt>{t("HTTP workers / queue capacity")}</dt>
              <dd>
                {t("{workers} / {capacity} (not queue depth)", { workers: number(r.http_workers_active), capacity: number(r.generation_queue_capacity) })}
              </dd>
              <dt>{t("Scheduler")}</dt>
              <dd>{r.generation_scheduler}</dd>
              <dt>{t("Context default / maximum")}</dt>
              <dd>
                {t("{default} / {maximum} tokens", { default: number(r.context_window_default), maximum: number(r.context_window_max) })}
              </dd>
              <dt>{t("KV mode / persistence")}</dt>
              <dd>
                {r.kv_mode} / {t(r.session_persistence ? "Enabled" : "Disabled")}
              </dd>
              <dt>{t("Pending commits / failures")}</dt>
              <dd>
                {number(r.session_persistence_pending)} /{" "}
                {number(r.session_persistence_failures)}
              </dd>
              <dt>{t("Garbage collection")}</dt>
              <dd>{t(r.session_gc_active ? "Active" : "Idle")}</dd>
              <dt>{t("Runtime observation")}</dt>
              <dd>
                {date(runtime!.observedAt)} ·{" "}
                {number(runtime!.durationMs)} ms
              </dd>
            </dl>
          )}
          <h3>{t("Last completed backend request resources")}</h3>
          <p className="muted">
            {t("Backend-wide, not necessarily this conversation. Memory is sampled after that request, not live GPU usage. The kernel does not report the resource sample time.")}
          </p>
          {usage?.state === "unavailable" && (
            <p role="status">
              {t("Resource status unavailable")} · {usage.code}: {usage.message}
            </p>
          )}
          {memory && u && (
            <dl>
              <dt>{t("Sample model / request")}</dt>
              <dd>
                {u.model} / {u.request_sequence}
              </dd>
              <dt>{t("Sample session")}</dt>
              <dd className="mono">{u.session_id || t("Not reported")}</dd>
              <dt>{t("Backend process RSS / peak")}</dt>
              <dd>
                {gib(memory.process_rss_bytes)} /{" "}
                {gib(memory.process_peak_rss_bytes)}
              </dd>
              <dt>{t("GPU used / total")}</dt>
              <dd>
                {memory.gpu_available
                  ? `${gib(memory.gpu_used_bytes)} / ${gib(memory.gpu_total_bytes)}`
                  : t("Not available")}
              </dd>
              <dt>{t("KV committed tokens")}</dt>
              <dd>
                {memory.kv_available
                  ? number(memory.kv_committed_tokens)
                  : t("Not available")}
              </dd>
              <dt>{t("KV reads / writes / I/O errors")}</dt>
              <dd>
                {memory.kv_available
                  ? `${number(memory.kv_submitted_reads)} / ${number(memory.kv_submitted_writes)} / ${number(memory.kv_io_errors)}`
                  : t("Not available")}
              </dd>
              <dt>{t("Snapshot retrieved")}</dt>
              <dd>
                {t("{time} · not its sample time", { time: date(usage!.observedAt) })}
              </dd>
            </dl>
          )}
        </>
      )}
    </article>
  );
}
