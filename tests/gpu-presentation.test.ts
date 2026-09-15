import test from "node:test";
import assert from "node:assert/strict";
import { gpuProbeState, type GpuTelemetry } from "../src/shared/gpu-telemetry";
import type { BackendProbe } from "../src/shared/backend-status";

test("GPU presentation distinguishes a missing connection, failed enumeration, old samples and measured zero", () => {
  const data: GpuTelemetry = {
    schema: "synora_gpu_telemetry_v1",
    scope: "host-devices-not-inference-allocation",
    sampledAt: 10_000,
    durationMs: 1,
    devices: [],
    issues: [],
  };
  const probe: BackendProbe<GpuTelemetry> = {
    state: "available",
    data,
    observedAt: 10_000,
    durationMs: 1,
    httpStatus: 200,
  };
  assert.equal(gpuProbeState(undefined, 10_000), "waiting");
  assert.equal(
    gpuProbeState(
      {
        state: "unavailable",
        code: "GPU_NOT_CONFIGURED",
        message: "Missing",
        observedAt: 10_000,
        durationMs: 0,
        httpStatus: null,
      },
      10_000,
    ),
    "not-configured",
  );
  assert.equal(gpuProbeState(probe, 10_000), "empty");
  data.issues = ["nvidia-unavailable", "drm-unavailable"];
  assert.equal(
    gpuProbeState(probe, 10_000),
    "unavailable",
    "A sensor failure is not no GPU",
  );
  data.devices = [
    {
      id: "real-id",
      identity: "device",
      name: "Dynamic device",
      vendor: "nvidia",
      pciBusId: null,
      source: "nvidia-smi",
      utilizationPercent: 0,
      memoryTotalBytes: null,
      memoryUsedBytes: null,
      temperatureCelsius: null,
    },
  ];
  assert.equal(
    gpuProbeState(probe, 10_000),
    "available",
    "Partial adapters do not suppress known sensors",
  );
  assert.equal(data.devices[0].utilizationPercent, 0);
  assert.equal(gpuProbeState(probe, 20_000), "stale");
  assert.equal(
    gpuProbeState(probe, 1_000),
    "stale",
    "Future timestamps are not live",
  );
  assert.equal(gpuProbeState(probe, 10_000, "Network lost"), "unavailable");
});
