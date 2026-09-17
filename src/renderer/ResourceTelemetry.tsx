import { useCallback, useEffect, useId, useState } from "react";
import type { DesktopAPI, EngineSnapshot, LocalMetrics } from "../shared/contracts";
import { sampleClockNow, type BackendStatus as Status } from "../shared/backend-status";
import { appendMemoryPoint, MEMORY_HISTORY_MS, requestRates, sampleStale, utilization, type MemoryPoint } from "../shared/resource-telemetry";
import { contextView } from "./ContextUsage";
import { BackendStatus } from "./BackendStatus";
import { GpuTelemetry } from "./GpuTelemetry";
import { HardwareTelemetry } from "./HardwareTelemetry";
import { useI18n } from "./i18n";
import { messages } from "./locales/resource-telemetry";

function Meter({ label, used, total, text, state, note, source, timestamp }: {
  label: string; used: number | null; total: number | null; text: string; state: string;
  note: string; source: string; timestamp?: string;
}) {
  const id = useId();
  const value = utilization(used, total);
  return <article className="card resource-meter" data-resource={label}>
    <div className="resource-heading"><h3>{label}</h3><small>{state}</small></div>
    <strong className="resource-value">{text}</strong>
    <div className={`resource-track ${value ? "" : "unavailable"}`} role={value ? "meter" : undefined}
      aria-label={label} aria-valuemin={value ? 0 : undefined} aria-valuemax={value ? 100 : undefined}
      aria-valuenow={value?.fill} aria-valuetext={value ? text : undefined} aria-describedby={id}>
      {value && <span className="resource-fill" style={{ width: `${value.fill}%` }} />}
    </div>
    <p id={id}>{note}</p><small className="resource-source">{source}{timestamp && <><br />{timestamp}</>}</small>
  </article>;
}

/** Fixed-capacity utilization and fixed-time memory history. No character-token
 * estimates, simulated GPU load or cumulative-consumption/context conflation. */
export function ResourceTelemetry({ api, engine, metrics, axiom }: {
  api: Pick<DesktopAPI, "backendStatus">; engine: EngineSnapshot; metrics: LocalMetrics | null; axiom: boolean;
}) {
  const { t, number, locale } = useI18n(messages);
  const fixed = (v: number, digits = 1) => new Intl.NumberFormat(locale === "pt" ? "pt-PT" : locale,
    { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(v);
  const date = (v: number) => new Date(v).toLocaleTimeString(locale === "pt" ? "pt-PT" : locale);
  const [now, setNow] = useState(Date.now()), [history, setHistory] = useState<MemoryPoint[]>([]);
  const [observation, setObservation] = useState<{ status: Status | null; error: string }>({ status: null, error: "" });
  const onObservation = useCallback((status: Status | null, error: string) => setObservation({ status, error }), []);
  useEffect(() => {
    const tick = () => { if (document.visibilityState === "visible") setNow(Date.now()); };
    const timer = setInterval(tick, 1000);
    document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", tick); };
  }, []);
  const host = metrics?.hostMemory?.state === "available" ? metrics.hostMemory : null;
  const capacity = host?.totalBytes ?? metrics?.localMemory?.physicalMemoryBytes ?? null;
  useEffect(() => {
    if (metrics && capacity) setHistory(old => appendMemoryPoint(old,
      { at: metrics.observedAt, rssBytes: metrics.rssBytes, totalBytes: capacity }, Date.now()));
  }, [metrics, capacity]);
  const status = axiom && observation.status?.mode === "live" ? observation.status : null;
  const resources = status?.resources.state === "available" ? status.resources.data : null;
  const vram = resources?.resources_after.gpu_available ? resources.resources_after : null;
  const ctx = contextView(engine);
  const active = ["running", "waiting"].includes(engine.status);
  const report = engine.usage;
  const turn = report && (!active || report.turnId === engine.turnId) ? report.turn : null;
  const rates = requestRates(engine.backendRequests, engine.threadId);
  const amount = (used: number | null | undefined, total: number | null) => {
    const value = utilization(used, total);
    return value ? `${t("{used} / {total} GiB", { used: fixed(value.used / 1024 ** 3), total: fixed(value.total / 1024 ** 3) })} · ${t("{percent}% used", { percent: fixed(value.percent) })}` : t("Unavailable");
  };
  const source = (value: string) => t("Source: {source}", { source: value });
  const sampled = (at: number | null | undefined) => at != null ? t("Updated {time}", { time: date(at) }) : undefined;
  const state = (at: number | null | undefined) => t(sampleStale(at, now) ? "Stale" : "Live sample");
  const visibleHistory = history.filter(p => p.at >= now - MEMORY_HISTORY_MS);
  // X is an actual fixed 120-second window; skipped/hidden samples leave gaps.
  const segments: MemoryPoint[][] = [];
  for (const p of visibleHistory) {
    const segment = segments.at(-1);
    if (!segment || p.at - segment[segment.length - 1].at > 7000) segments.push([p]);
    else segment.push(p);
  }
  const xy = (p: MemoryPoint) => [Math.max(0, Math.min(300, (p.at - now + MEMORY_HISTORY_MS) / MEMORY_HISTORY_MS * 300)),
    80 - Math.min(1, p.rssBytes / p.totalBytes) * 76];
  const count = (v: number | undefined) => v === undefined ? "—" : number(v);
  const rateChart = (field: "decode" | "prefill") => {
    const points = rates.filter(r => r[field] !== null && Number.isFinite(r[field]));
    const max = Math.max(1, ...points.map(r => r[field]!));
    return <article className="card resource-history" data-rate={field}>
      <h3>{t(field === "decode" ? "Decode speed" : "Prefill speed")}</h3>
      <strong className="resource-value">{points.length ? t("{rate} tok/s", { rate: fixed(points.at(-1)![field]!) }) : "—"}</strong>
      <p>{t("Completed Axiom requests · not instantaneous throughput")}</p>
      {field === "prefill" && <small>{t("Measured suffix prefill only; cached tokens are excluded.")}</small>}
      {points.length ? <div className="resource-rate-bars" aria-label={t(field === "decode" ? "Decode speed" : "Prefill speed")}
        style={{ gridTemplateColumns: `repeat(${Math.max(6, points.length)}, minmax(0, 1fr))` }}>
        {points.map(p => <div key={p.id} className="resource-rate-slot" tabIndex={0}
          aria-label={`${date(p.at)} · ${t("{rate} tok/s", { rate: fixed(p[field]!) })}`}>
          <span style={{ height: `${p[field]! / max * 100}%` }} />
          <span className="resource-rate-tooltip">{date(p.at)}<br />{t("{rate} tok/s", { rate: fixed(p[field]!) })}</span>
        </div>)}
      </div> : <div className="resource-chart-empty">{t("No measurements yet")}</div>}
      {points.length > 0 && <small className="resource-source">{source("Axiom response")} · 0–{fixed(max)} tok/s</small>}
    </article>;
  };
  return <>
    <section className="resource-telemetry" aria-label={t("Resource usage")}>
      <p className="muted">{t("Live measurements and reported samples stay separate.")}</p>
      <div className="resource-grid">
        <Meter label={t("Local host RAM")} used={host?.nonFreeBytes ?? null} total={host?.totalBytes ?? null}
          text={amount(host?.nonFreeBytes, host?.totalBytes ?? null)} state={host ? state(host.observedAt) : t("Unavailable")}
          note={t("Non-free host memory, including OS and caches; not Synora alone.")} source={source("node:os")}
          timestamp={sampled(host?.observedAt)} />
        <Meter label={t("Synora service RAM")} used={metrics?.rssBytes ?? null} total={capacity}
          text={amount(metrics?.rssBytes, capacity)} state={metrics ? state(metrics.observedAt) : t("Unavailable")}
          note={t("Main process RSS as a share of host RAM; not all app processes.")} source={source("process.memoryUsage")}
          timestamp={sampled(metrics?.observedAt)} />
        <Meter label={t("Axiom VRAM")} used={vram?.gpu_used_bytes ?? null} total={vram?.gpu_total_bytes ?? null}
          text={amount(vram?.gpu_used_bytes, vram?.gpu_total_bytes ?? null)}
          state={t(!axiom ? "Not applicable" : vram ? sampleStale(status?.resources.observedAt, now) ? "Stale" : "Last request" : "Unavailable")}
          note={t("Last completed backend request; not necessarily this conversation. Sample time not reported.")}
          source={source("Axiom /ops/usage")}
          timestamp={status?.resources ? t("Retrieved {time}; not the sample time", { time: date(status.resources.observedAt) }) : undefined} />
        {!status?.gpu && <Meter label={t("GPU utilization")} used={null} total={null} text={t("Unavailable")}
          state={t(!axiom ? "Not applicable" : "Unavailable")}
          note={t(axiom ? "No live GPU utilization source is exposed by this backend." : "Not exposed by this provider")}
          source={source("—")} />}
        <Meter label={t("Context occupancy")} used={ctx.used} total={ctx.capacity}
          text={ctx.used !== null ? `${number(ctx.used)} / ${ctx.capacity ? number(ctx.capacity) : "—"} · ${ctx.percent !== null ? t("{percent}% used", { percent: fixed(ctx.percent) }) : "—"}` : "—"}
          state={t("Latest report")} note={t(ctx.refreshing ? "Waiting for updated usage after compaction." : "Latest Core report; not cumulative token consumption.")}
          source={source("Core thread/tokenUsage/updated")} timestamp={sampled(report?.observedAt)} />
        <article className="card resource-counters">
          <h3>{t("Current turn tokens")}</h3><strong className="resource-value">{count(turn?.totalTokens)}</strong>
          <dl><dt>{t("Conversation tokens")}</dt><dd>{count(ctx.usage?.total.totalTokens)}</dd>
            <dt>{t("Input / output")}</dt><dd>{count(turn?.inputTokens)} / {count(turn?.outputTokens)}</dd></dl>
          <p>{t("Reasoning is included in output; cached input is included in input.")}</p>
          <small>{t(turn ? "Reported counters update when Core emits usage." : "Historical counters; no current-turn report yet.")}</small>
        </article>
      </div>
      {status?.hardware?.state === "available" ? <HardwareTelemetry hardware={status.hardware.data} now={sampleClockNow(status.hardware, now)} /> : status?.gpu && <GpuTelemetry probe={status.gpu} now={now} />}
      <div className="resource-charts">
        <article className="card resource-history"><h3>{t("Local memory history")}</h3><p>{t("Last 120 seconds · service RSS / host RAM")}</p>
          {visibleHistory.length ? <svg className="resource-line-chart" viewBox="0 0 300 84" role="img" aria-label={t("Local memory history")}>
            {[4, 42, 80].map(y => <path key={y} d={`M0 ${y}H300`} className="resource-chart-grid" />)}
            {segments.map((segment, i) => <g key={i}><polyline points={segment.map(p => xy(p).join(",")).join(" ")} />
              {segment.map(p => { const [cx, cy] = xy(p); return <circle key={p.at} cx={cx} cy={cy} r="1.7"><title>{date(p.at)} · {fixed(p.rssBytes / 1024 ** 2)} MiB</title></circle>; })}</g>)}
          </svg> : <div className="resource-chart-empty">{t("No measurements yet")}</div>}
          <small className="resource-source">0–100% · {source("process.memoryUsage / node:os")}</small>
        </article>{rateChart("decode")}{rateChart("prefill")}
      </div>
    </section>
    <BackendStatus api={api} onObservation={onObservation} />
  </>;
}
