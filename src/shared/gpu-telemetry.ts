import { z } from "zod";
import type { BackendProbe } from "./backend-status";
import { sampleStale } from "./resource-telemetry";

const bytes = z.number().int().nonnegative().safe();
export const gpuDeviceSchema = z
  .object({
    id: z.string().min(1).max(240),
    identity: z.enum(["device", "pci-slot"]),
    name: z.string().min(1).max(240),
    vendor: z.enum(["nvidia", "amd", "intel", "other"]),
    pciBusId: z
      .string()
      .regex(/^[0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i)
      .nullable(),
    source: z.enum(["nvidia-smi", "linux-drm"]),
    utilizationPercent: z.number().finite().min(0).max(100).nullable(),
    memoryTotalBytes: bytes.positive().nullable(),
    memoryUsedBytes: bytes.nullable(),
    temperatureCelsius: z.number().finite().min(-100).max(250).nullable(),
  })
  .strict()
  .refine(
    (d) =>
      d.memoryUsedBytes === null ||
      d.memoryTotalBytes === null ||
      d.memoryUsedBytes <= d.memoryTotalBytes,
    "Used GPU memory cannot exceed reported capacity",
  );

export const gpuTelemetrySchema = z
  .object({
    schema: z.literal("synora_gpu_telemetry_v1"),
    scope: z.literal("host-devices-not-inference-allocation"),
    sampledAt: bytes,
    durationMs: bytes,
    devices: z.array(gpuDeviceSchema).max(64),
    // Partial adapter failures do not erase usable measurements from another vendor.
    issues: z
      .array(
        z.enum([
          "nvidia-unavailable",
          "nvidia-invalid",
          "drm-unavailable",
          "drm-device-unavailable",
        ]),
      )
      .max(4),
  })
  .strict()
  .refine(
    (v) => new Set(v.devices.map((d) => d.id)).size === v.devices.length,
    "Duplicate GPU identities",
  );

export type GpuDevice = z.infer<typeof gpuDeviceSchema>;
export type GpuTelemetry = z.infer<typeof gpuTelemetrySchema>;

/** Unknown sensors, an empty inventory and an old measurement are different
 * states. In particular a failed enumeration is not proof that no GPU exists. */
export function gpuProbeState(
  probe: BackendProbe<GpuTelemetry> | undefined,
  now: number,
  error = "",
) {
  if (error) return "unavailable";
  if (!probe) return "waiting";
  if (probe.state === "unavailable")
    return probe.code === "GPU_NOT_CONFIGURED"
      ? "not-configured"
      : "unavailable";
  if (sampleStale(probe.data.sampledAt, now)) return "stale";
  if (!probe.data.devices.length)
    return probe.data.issues.length ? "unavailable" : "empty";
  return "available";
}
