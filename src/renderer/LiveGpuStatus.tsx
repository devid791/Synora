import type { BackendStatus } from "../shared/backend-status";
import type { EngineSnapshot } from "../shared/contracts";
import { sampleStale } from "../shared/resource-telemetry";
import { gpuProbeState } from "../shared/gpu-telemetry";
import { HardwareTelemetry } from "./HardwareTelemetry";
import { messages as hardwareMessages } from "./locales/hardware";
import { useI18n } from "./i18n";
import { messages as composerMessages } from "./locales/composer";
import { messages as statusMessages } from "./locales/status-bar";
import { messages as gpuMessages } from "./locales/gpu-telemetry";
const messages = { ...composerMessages, ...statusMessages, ...gpuMessages, ...hardwareMessages };

/** Core turn activity is event-driven; physical utilization is sensor-only.
 * A sub-two-second turn must never be represented as an idle GPU task. */
export function LiveGpuStatus({
  backend,
  engine,
  now,
  error,
  compact = false,
}: {
  backend: BackendStatus | null;
  engine: EngineSnapshot;
  now: number;
  error: string;
  compact?: boolean;
}) {
  const { t, locale } = useI18n(messages);
  const fixed = (v: number, digits = 0) =>
    new Intl.NumberFormat(locale, { maximumFractionDigits: digits }).format(v);
  const runtime = backend?.mode === "live" ? backend.runtime : undefined;
  const gpu = backend?.mode === "live" ? backend.gpu : undefined;
  const hardware = backend?.mode === "live" && backend.hardware?.state === "available" ? backend.hardware.data : null;
  const state = gpuProbeState(gpu, now, error);
  const devices =
    state === "available" && gpu?.state === "available"
      ? gpu.data.devices
      : null;
  const unavailableLabel = t(
    {
      available: "GPU: live sample unavailable",
      waiting: "GPU: live sample unavailable",
      "not-configured": "GPU telemetry setup required",
      unavailable: "GPU telemetry unavailable",
      stale: "GPU sample stale",
      empty: "No GPU detected",
    }[state],
  );
  const unavailableHint =
    state === "not-configured"
      ? t(
          "This client needs a trusted GPU collector connection for the selected Axiom provider. Inference does not depend on telemetry.",
        )
      : error ||
        (gpu?.state === "unavailable" ? gpu.message : unavailableLabel);
  let host = "—";
  if (backend?.mode === "live") {
    try {
      host = new URL(backend.endpoint).host;
    } catch {
      /* No guessed host. */
    }
  }
  const activity =
    engine.status === "running"
      ? "Axiom turn active"
      : engine.status === "waiting"
        ? "Axiom awaiting approval"
        : !error &&
            runtime?.state === "available" &&
            !sampleStale(runtime.observedAt, now)
          ? runtime.data.generation_busy
            ? "Axiom generating"
            : "Axiom idle"
          : "Backend status stale / unavailable";
  if (compact) {
    if (!devices?.length)
      return (
        <span
          data-gpu-unavailable
          data-gpu-state={state}
          title={unavailableHint}
        >
          {unavailableLabel}
        </span>
      );
    if (devices.length > 1)
      return (
        <span
          data-gpu-count={devices.length}
          title={`${t("Axiom server · {host}", { host })}. ${devices.map((d) => d.name).join(", ")}. ${t(
            "Sensor readings for each device are in Details; no averaged GPU load.",
          )}`}
        >
          {t("{count} GPUs", { count: devices.length })}
        </span>
      );
    const device = devices[0];
    return (
      <span
        data-gpu-live={device.id}
        className="status-gpu-readout"
        title={`${t("Axiom server · {host}", { host })} · ${device.name} · ${device.pciBusId ?? device.id} · ${device.source}`}
      >
        <span className="status-gpu-scope">{t("Server GPU")}</span>
        <span className="status-gpu-name" data-gpu-name>
          {device.name}
        </span>
        <span className="status-gpu-load" data-gpu-load>
          {device.utilizationPercent === null
            ? "—"
            : `${fixed(device.utilizationPercent)}%`}
        </span>
        {device.memoryUsedBytes !== null &&
          device.memoryTotalBytes !== null && (
            <span className="status-gpu-memory">
              {" · "}{t(device.memoryKind === "unified" ? "Unified memory" : device.memoryKind === "unknown" ? "Memory type unknown" : "VRAM")} {fixed(device.memoryUsedBytes / 1024 ** 3, 1)}/
              {fixed(device.memoryTotalBytes / 1024 ** 3, 1)} GiB
            </span>
          )}
      </span>
    );
  }
  return (
    <>
      <span
        data-axiom-activity={engine.status}
        title={t(
          "Turn state comes from Core events; GPU percentages come only from host sensors.",
        )}
      >
        {t(activity)}
      </span>
      <span data-gpu-origin>{t("Axiom server · {host}", { host })}</span>
      <span className="telemetry-caption">
        {t(
          "Sensors come from the Axiom host, which may be a different computer. Host-wide usage does not identify which GPU this conversation uses.",
        )}
      </span>
      {hardware ? <HardwareTelemetry hardware={hardware} now={error ? Number.MAX_SAFE_INTEGER : now} /> : devices?.length ? (
        devices.map((device) => (
          <span key={device.id} className="telemetry-gpu-device">
            <span
              data-gpu-live={device.id}
              title={`${device.name} · ${device.pciBusId ?? device.id} · ${device.source} · ${new Date(gpu!.state === "available" ? gpu!.data.sampledAt : now).toLocaleTimeString(locale)}`}
            >
              GPU {device.name} ·{" "}
              {device.utilizationPercent === null
                ? "—"
                : `${fixed(device.utilizationPercent)}%`}
              {device.memoryUsedBytes !== null &&
                device.memoryTotalBytes !== null && (
                  <>
                    {" "}
                    · VRAM {fixed(device.memoryUsedBytes / 1024 ** 3, 1)}/
                    {fixed(device.memoryTotalBytes / 1024 ** 3, 1)} GiB
                  </>
                )}
              {device.temperatureCelsius !== null && (
                <> · {fixed(device.temperatureCelsius)} °C</>
              )}
            </span>
            <small className="telemetry-caption" data-gpu-source>
              {device.id} · {device.pciBusId ?? "—"} · {device.source}
              {" · "}
              {t("Sampled {time}", {
                time: new Date(
                  gpu!.state === "available" ? gpu!.data.sampledAt : now,
                ).toLocaleTimeString(locale),
              })}
            </small>
          </span>
        ))
      ) : (
        <span
          data-gpu-unavailable
          data-gpu-state={state}
          title={unavailableHint}
        >
          {unavailableLabel}
          {state === "not-configured" && (
            <small className="telemetry-caption">{unavailableHint}</small>
          )}
        </span>
      )}
      {devices && gpu?.state === "available" && gpu.data.issues.length > 0 && (
        <span className="telemetry-caption">
          {t("Some device sensors are unavailable.")}
        </span>
      )}
    </>
  );
}
