import type { Hardware } from "../shared/hardware";
import { sampleStale } from "../shared/resource-telemetry";
import { useI18n } from "./i18n";
import { messages as hardwareMessages } from "./locales/hardware";
import { messages as gpuMessages } from "./locales/gpu-telemetry";
const messages = { ...hardwareMessages, ...gpuMessages };

/** Physical pools belong to nodes, not cards. Never sum a shared pool per GPU. */
export function HardwareTelemetry({ hardware: h, now }: { hardware: Hardware; now: number }) {
  const { t, locale } = useI18n(messages);
  const fixed = (n: number, digits = 1) => new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(n);
  const size = (n: number | null) => n === null ? "—" : `${fixed(n / 1024 ** 3)} GiB`;
  const fresh = !sampleStale(h.sampledAt, now);
  const names = h.execution.deviceIds.map(id => h.devices.find(d => d.id === id)!.name).join(" · ");
  const mode = { "single-device": "Single GPU", "multi-device": "Multiple GPUs", cluster: "Distributed model", cpu: "CPU", unknown: "Unknown assignment" }[h.execution.mode];
  const memoryLabel = { dedicated: "Dedicated VRAM", unified: "Unified memory", system: "System RAM", unknown: "Memory type unknown" };
  return <section className="hardware-telemetry" aria-label={t("Server hardware")}>
    <div className="hardware-heading"><strong>{t("Server hardware")}</strong><span>{t(h.topology === "cluster" ? "Cluster" : h.topology === "single-node" ? "Single node" : "Unknown topology")} · {h.nodes.length}</span></div>
    <p className="telemetry-caption" data-hardware-assignment>{t("Loaded model")}: {t(mode)}{names ? ` · ${names}` : ""}{!fresh ? ` · ${t("Stale")}` : ""}</p>
    <p className="telemetry-caption">{t("Assignment is reported by the runtime. Sensor usage includes other processes.")}</p>
    {h.nodes.map(node => {
      const live = fresh && node.state === "online" && !sampleStale(node.sampledAt, now);
      return <div className="hardware-node" key={node.id} data-hardware-node={node.id}>
        <div className="hardware-heading"><strong>{node.name}</strong><small>{t(node.state === "offline" ? "Offline" : node.state === "unavailable" ? "Unavailable" : live ? "Live sample" : "Stale")}</small></div>
        {h.devices.filter(d => d.nodeId === node.id).map(d => <div className="hardware-device" key={d.id} data-gpu-live={live ? d.id : undefined}>
          <span><strong>{d.name}</strong>{h.execution.deviceIds.includes(d.id) && <small> · {t("Loaded model")}</small>}</span>
          <span>{live && d.utilizationPercent !== null ? `${fixed(d.utilizationPercent)}%` : "—"}{live && d.temperatureCelsius !== null ? ` · ${fixed(d.temperatureCelsius)} °C` : ""}</span>
          <small className="hardware-identity">{d.pciBusId ?? d.uuid ?? d.id} · {t(memoryLabel[d.memoryKind])}{d.numaNode !== null ? ` · NUMA ${d.numaNode}` : ""}</small>
          {d.memoryKind === "unified" && <small>{t("GPU-addressable capacity")}: {size(d.addressableMemoryBytes)}</small>}
        </div>)}
        {h.memoryPools.filter(p => p.nodeId === node.id).map(p => <div key={p.id} className="hardware-pool" data-memory-pool={p.id}>
          <span>{t(memoryLabel[p.kind])}</span><strong>{live ? size(p.usedBytes) : "—"} / {size(p.totalBytes)}</strong>
          <small>{p.kind === "unified" ? t("Shared by CPU and GPU; counted once.") : ""} {t("Source: {source}", { source: p.source })}</small>
        </div>)}
        <small className="telemetry-caption">{t("Sampled {time}", { time: new Date(node.sampledAt).toLocaleTimeString(locale) })}</small>
      </div>;
    })}
    {h.links.length > 0 && <details><summary>{t("Device links")} · {h.links.length}</summary>{h.links.map(l => <p key={`${l.from}:${l.to}:${l.kind}`} className="telemetry-caption">
      {h.devices.find(d => d.id === l.from)!.name} ↔ {h.devices.find(d => d.id === l.to)!.name} · {l.kind} · {t(!fresh || l.accessible === null ? "Unknown" : l.accessible ? "Available" : "Unavailable")}
    </p>)}</details>}
    {h.issues.length > 0 && <p role="status" className="telemetry-caption">{t("Some device sensors are unavailable.")}</p>}
  </section>;
}
