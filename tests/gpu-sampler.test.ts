import test from "node:test";
import assert from "node:assert/strict";
import { normalize, basename } from "node:path";
import { NVIDIA_QUERY, parseNvidiaGpus, sampleGpus, type GpuSamplerIO } from "../src/main/gpu-sampler";
import { gpuTelemetrySchema } from "../src/shared/gpu-telemetry";
const line = (uuid = "GPU-12345678", name = "Fixture GPU", used = 4096) =>
  `${uuid}, ${name}, 00000000:03:00.0, 42, 16384, ${used}, 48`;
function io(overrides: Partial<GpuSamplerIO> = {}): GpuSamplerIO {
  return { nvidia: async () => line(), cards: async () => [], devicePath: async () => { throw Error("Missing"); },
    read: async () => { throw Error("Unsupported"); }, now: () => 1000, monotonic: () => 1, ...overrides };
}
test("NVIDIA queries only read-only columns and never fixes a device index/model", () => {
  assert.equal(NVIDIA_QUERY.length, 2); assert.ok(NVIDIA_QUERY[0].startsWith("--query-gpu="));
  assert.equal(NVIDIA_QUERY[1], "--format=csv,noheader,nounits");
  const [d] = parseNvidiaGpus(line());
  assert.equal(d.id, "nvidia:GPU-12345678"); assert.equal(d.identity, "device");
  assert.equal(d.pciBusId, "0000:03:00.0"); assert.equal(d.memoryTotalBytes, 16 * 1024 ** 3);
  assert.equal(d.memoryUsedBytes, 4 * 1024 ** 3); assert.equal(d.utilizationPercent, 42);
});
test("Multiple GPU models and CSV names are supported; missing sensors are not zero", () => {
  const rows = `${line("GPU-12345678", '"GPU, double width"')}\nGPU-abcdefgh, Other, 00000000:04:00.0, N/A, N/A, N/A, N/A`;
  const good = rows.replace("GPU-abcdefgh", "GPU-abcdef12");
  const devices = parseNvidiaGpus(good);
  assert.equal(devices.length, 2); assert.equal(devices[0].name, "GPU, double width");
  assert.equal(devices[1].utilizationPercent, null); assert.equal(devices[1].memoryTotalBytes, null);
  assert.equal(devices[1].temperatureCelsius, null); assert.throws(() => parseNvidiaGpus(rows));
});
test("Malformed, over-capacity and duplicate device reports fail closed", () => {
  assert.throws(() => parseNvidiaGpus(`${line()}\n${line()}`));
  assert.throws(() => parseNvidiaGpus(line("GPU-12345678", "GPU", 20000)));
  assert.throws(() => parseNvidiaGpus('"unterminated'));
  assert.throws(() => parseNvidiaGpus(line().replace(", 42,", ", 101,")));
  assert.throws(() => parseNvidiaGpus("x".repeat(256 * 1024 + 1)));
});
test("Every sample rediscovers additions, removals, reordered devices and replacement UUID/capacity", async () => {
  let rows = line(), calls = 0;
  const env = io({ nvidia: async () => { calls++; return rows; } });
  const first = await sampleGpus(env);
  rows = `${line("GPU-abcdef12", "New GPU").replace("16384", "32768")}\n${line()}`;
  const second = await sampleGpus(env); assert.equal(second.devices.length, 2);
  assert.equal(second.devices.find(d => d.name === "New GPU")?.memoryTotalBytes, 32 * 1024 ** 3);
  rows = line("GPU-abcdef12", "New GPU").replace("16384", "32768");
  const third = await sampleGpus(env); assert.equal(third.devices.length, 1);
  assert.notEqual(third.devices[0].id, first.devices[0].id);
  rows = ""; assert.deepEqual((await sampleGpus(env)).devices, []); assert.equal(calls, 4);
});
test("Driver failure never returns a previous successful sample", async () => {
  const first = await sampleGpus(io()); assert.equal(first.devices.length, 1);
  const failed = await sampleGpus(io({ nvidia: async () => { throw Error("Driver missing"); } }));
  assert.deepEqual(failed.devices, []); assert.deepEqual(failed.issues, ["nvidia-unavailable"]);
});
test("DRM discovers AMD and unsupported Intel sensors dynamically, without vendor conflation", async () => {
  const values: Record<string, string> = Object.fromEntries(Object.entries({
    "/sys/devices/0000:04:00.0/vendor": "0x1002", "/sys/devices/0000:04:00.0/device": "0x1234",
    "/sys/devices/0000:04:00.0/unique_id": "a123456789abcdef",
    "/sys/devices/0000:04:00.0/mem_info_vram_total": "16000000000", "/sys/devices/0000:04:00.0/mem_info_vram_used": "4000000000",
    "/sys/devices/0000:04:00.0/gpu_busy_percent": "27",
    "/sys/devices/0000:05:00.0/vendor": "0x8086", "/sys/devices/0000:05:00.0/device": "0xabcd",
  }).map(([path, value]) => [normalize(path), value]));
  const report = await sampleGpus(io({ cards: async () => ["card0", "card0-HDMI-A-1", "card3"],
    devicePath: async card => `/sys/devices/0000:0${card === "card0" ? 4 : 5}:00.0`, read: async path => {
      if (!(path in values)) throw Error("Sensor not supported"); return values[path];
    } }));
  assert.equal(report.devices.length, 3);
  const amd = report.devices.find(d => d.vendor === "amd")!, intel = report.devices.find(d => d.vendor === "intel")!;
  assert.equal(amd.utilizationPercent, 27); assert.equal(amd.identity, "device");
  assert.equal(intel.identity, "pci-slot"); assert.equal(intel.utilizationPercent, null); assert.equal(intel.memoryTotalBytes, null);
});
test("NVIDIA DRM device does not double-count an already measured PCI device", async () => {
  const report = await sampleGpus(io({ cards: async () => ["card0", "card1"], devicePath: async () => "/sys/devices/0000:03:00.0",
    read: async path => basename(path) === "vendor" ? "0x10de" : basename(path) === "device" ? "0x1234" : "" }));
  assert.equal(report.devices.length, 1);
});
test("Schema retains honest host-wide scope and refuses duplicate identities or invalid clocks", async () => {
  const report = await sampleGpus(io());
  assert.equal(report.scope, "host-devices-not-inference-allocation");
  assert.equal(gpuTelemetrySchema.safeParse({ ...report, devices: [...report.devices, ...report.devices] }).success, false);
  await assert.rejects(() => sampleGpus(io({ now: () => NaN })));
});
