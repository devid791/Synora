import { sampleClockNow, type BackendProbe } from "../shared/backend-status";
import type { GpuTelemetry as Sample } from "../shared/gpu-telemetry";
import { sampleStale, utilization } from "../shared/resource-telemetry";
import { useI18n } from "./i18n";
import { messages as gpuMessages } from "./locales/gpu-telemetry";
import { messages as statusMessages } from "./locales/status-bar";
const messages = { ...gpuMessages, ...statusMessages };

export function GpuTelemetry({ probe, now }: { probe: BackendProbe<Sample>; now: number }) {
  const { t, locale } = useI18n(messages);
  const fixed = (value: number, digits = 1) => new Intl.NumberFormat(locale === "pt" ? "pt-PT" : locale,
    { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
  const data = probe.state === "available" ? probe.data : null;
  const stale = data ? sampleStale(data.sampledAt, sampleClockNow(probe, now)) : true;
  const bar = (label: string, used: number | null, total: number | null, text: string) => {
    const value = utilization(used, total);
    return <div className="gpu-measurement"><span>{label}</span><strong>{value ? text : t("Unavailable")}</strong>
      <div className={`resource-track ${value ? "" : "unavailable"}`} role={value ? "meter" : undefined} aria-label={label}
        aria-valuemin={value ? 0 : undefined} aria-valuemax={value ? 100 : undefined} aria-valuenow={value?.fill}
        aria-valuetext={value ? text : undefined}>
        {value && <span className="resource-fill" style={{ width: `${value.fill}%` }} />}
      </div></div>;
  };
  return <section className="gpu-telemetry" aria-label={t("Live GPUs")}>
    <h2>{t("Live GPUs")}</h2><p>{t("Host-wide sensors; not memory allocated exclusively to Axiom.")}</p>
    {!data && <p role="status">{t(probe.state === "unavailable" && probe.code === "GPU_NOT_CONFIGURED" ? "GPU telemetry setup required" : "Collector unavailable")}
      {probe.state === "unavailable" && probe.code === "GPU_NOT_CONFIGURED" && <small className="telemetry-caption">{t("This client needs a trusted GPU collector connection for the selected Axiom provider. Inference does not depend on telemetry.")}</small>}
    </p>}
    {data && !data.devices.length && <p role="status">{t(data.issues.length ? "Collector unavailable" : stale ? "Stale" : "No GPU detected")}</p>}
    {!!data?.issues.length && <p role="status">{t("Some device sensors are unavailable.")}</p>}
    <div className="resource-grid">{data?.devices.map(gpu => <article key={gpu.id} className="card resource-meter" data-gpu-id={gpu.id}>
      <div className="resource-heading"><h3>{gpu.name}</h3><small>{t(stale ? "Stale" : "Live sample")}</small></div>
      {bar(t("GPU utilization"), gpu.utilizationPercent, 100, `${fixed(gpu.utilizationPercent ?? 0)}%`)}
      {bar(t("VRAM"), gpu.memoryUsedBytes, gpu.memoryTotalBytes,
        `${fixed((gpu.memoryUsedBytes ?? 0) / 1024 ** 3, 2)} / ${fixed((gpu.memoryTotalBytes ?? 0) / 1024 ** 3, 2)} GiB`)}
      <p className="mono resource-source">{gpu.id}<br />{gpu.pciBusId}</p>
      {gpu.identity === "pci-slot" && <small>{t("PCI slot identity; no device serial reported.")}</small>}
      <small className="resource-source">{t("Source: {source}", { source: gpu.source })}<br />
        {t("Sampled {time}", { time: new Date(data.sampledAt).toLocaleTimeString(locale === "pt" ? "pt-PT" : locale) })}
        {gpu.temperatureCelsius !== null && <> · {fixed(gpu.temperatureCelsius)} °C</>}</small>
    </article>)}</div>
  </section>;
}
