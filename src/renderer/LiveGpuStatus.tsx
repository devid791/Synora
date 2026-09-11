import type { BackendStatus } from "../shared/backend-status";
import type { EngineSnapshot } from "../shared/contracts";
import { sampleStale } from "../shared/resource-telemetry";
import { useI18n } from "./i18n";
import { messages as composerMessages } from "./locales/composer";
import { messages as statusMessages } from "./locales/status-bar";
const messages = { ...composerMessages, ...statusMessages };

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
  const devices =
    !error &&
    gpu?.state === "available" &&
    !sampleStale(gpu.data.sampledAt, now)
      ? gpu.data.devices
      : null;
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
          title={
            gpu?.state === "unavailable"
              ? gpu.message
              : t(devices ? "No GPU detected" : "GPU: live sample unavailable")
          }
        >
          {devices ? t("No GPU detected") : "GPU —"}
        </span>
      );
    if (devices.length > 1)
      return (
        <span
          data-gpu-count={devices.length}
          title={t(
            "Sensor readings for each device are in Details; no averaged GPU load.",
          )}
        >
          {t("{count} GPUs", { count: devices.length })}
        </span>
      );
    const device = devices[0];
    return (
      <span
        data-gpu-live={device.id}
        title={`${device.name} · ${device.pciBusId ?? device.id} · ${device.source}`}
      >
        GPU{" "}
        {device.utilizationPercent === null
          ? "—"
          : `${fixed(device.utilizationPercent)}%`}
        {device.memoryUsedBytes !== null &&
          device.memoryTotalBytes !== null && (
            <span className="status-gpu-memory">
              {" · "}VRAM {fixed(device.memoryUsedBytes / 1024 ** 3, 1)}/
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
      {devices?.length ? (
        devices.map((device) => (
          <span
            key={device.id}
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
        ))
      ) : (
        <span
          data-gpu-unavailable
          title={
            gpu?.state === "unavailable"
              ? gpu.message
              : t(
                  "Turn state comes from Core events; GPU percentages come only from host sensors.",
                )
          }
        >
          {t(devices ? "No GPU detected" : "GPU: live sample unavailable")}
        </span>
      )}
    </>
  );
}
