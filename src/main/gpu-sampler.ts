import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { performance } from "node:perf_hooks";
import { gpuDeviceSchema, gpuTelemetrySchema, type GpuDevice, type GpuTelemetry } from "../shared/gpu-telemetry";

export const NVIDIA_QUERY = [
  "--query-gpu=uuid,name,pci.bus_id,utilization.gpu,memory.total,memory.used,temperature.gpu",
  "--format=csv,noheader,nounits",
] as const;
const run = promisify(execFile);
const numeric = (text: string | undefined): number | null => {
  const value = text?.trim();
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  const n = Number(value); return Number.isFinite(n) ? n : null;
};
const pci = (text: string) => {
  const m = /^(?:0000)?([0-9a-f]{4}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7])$/i.exec(text.trim());
  return m?.[1].toLowerCase() ?? null;
};
function csv(line: string) {
  const fields: string[] = [];
  let text = "", quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (quoted && line[i + 1] === '"') { text += '"'; i++; }
      else quoted = !quoted;
    } else if (c === "," && !quoted) { fields.push(text.trim()); text = ""; }
    else text += c;
  }
  if (quoted) throw Error("Malformed GPU CSV");
  fields.push(text.trim()); return fields;
}

/** Enumerate every device on every read. Driver index and model name are not identities. */
export function parseNvidiaGpus(output: string): GpuDevice[] {
  if (Buffer.byteLength(output) > 256 * 1024) throw Error("GPU response too large");
  const lines = output.split(/\r?\n/).filter(v => v.trim());
  if (lines.length > 64) throw Error("GPU inventory too large");
  const result = lines.map(line => {
    const fields = csv(line);
    if (fields.length !== 7) throw Error("Unexpected GPU columns");
    const [uuid, name, bus, utilization, total, used, temperature] = fields;
    if (!/^GPU-[0-9a-f-]{8,100}$/i.test(uuid)) throw Error("No stable GPU UUID");
    const mib = (v: string) => {
      const n = numeric(v); return n === null ? null : n * 1024 ** 2;
    };
    return gpuDeviceSchema.parse({ id: `nvidia:${uuid}`, identity: "device", name, vendor: "nvidia",
      pciBusId: pci(bus), source: "nvidia-smi", utilizationPercent: numeric(utilization),
      memoryTotalBytes: mib(total), memoryUsedBytes: mib(used), temperatureCelsius: numeric(temperature) });
  });
  if (new Set(result.map(d => d.id)).size !== result.length) throw Error("Duplicate GPU UUID");
  return result;
}

export interface GpuSamplerIO {
  nvidia(): Promise<string>;
  cards(): Promise<string[]>;
  devicePath(card: string): Promise<string>;
  read(path: string): Promise<string>;
  now(): number;
  monotonic(): number;
}
const defaultIO: GpuSamplerIO = {
  nvidia: async () => (await run("/usr/bin/nvidia-smi", [...NVIDIA_QUERY], {
    timeout: 2000, killSignal: "SIGKILL", maxBuffer: 256 * 1024,
    env: { ...process.env, LC_ALL: "C" }, windowsHide: true,
  })).stdout,
  cards: () => readdir("/sys/class/drm"),
  devicePath: card => realpath(join("/sys/class/drm", card, "device")),
  read: path => readFile(path, "utf8"),
  now: Date.now,
  monotonic: () => performance.now(),
};

/** No timers, remembered GPU handles, configuration writes, CUDA allocation or
 * management commands. The future service owns cadence/deadline/access control.
 * Linux DRM is re-enumerated too; unsupported vendor sensors stay null. */
export async function sampleGpus(io: GpuSamplerIO = defaultIO): Promise<GpuTelemetry> {
  const sampledAt = io.now(), start = io.monotonic();
  const issues = new Set<GpuTelemetry["issues"][number]>();
  let devices: GpuDevice[] = [];
  try {
    const output = await io.nvidia();
    try { devices = parseNvidiaGpus(output); } catch { issues.add("nvidia-invalid"); }
  } catch { issues.add("nvidia-unavailable"); }
  let cards: string[] = [];
  try { cards = (await io.cards()).filter(n => /^card\d+$/.test(n)).slice(0, 64); }
  catch { issues.add("drm-unavailable"); }
  const observedPaths = new Set<string>();
  for (const card of cards) {
    try {
      const path = await io.devicePath(card), bus = pci(basename(path));
      if (!bus || observedPaths.has(path)) continue;
      observedPaths.add(path);
      const read = async (file: string) => { try { return (await io.read(join(path, file))).trim(); } catch { return ""; } };
      const vendorId = (await read("vendor")).toLowerCase(), deviceId = (await read("device")).toLowerCase();
      if (!/^0x[0-9a-f]{4}$/.test(vendorId) || !/^0x[0-9a-f]{4}$/.test(deviceId)) {
        issues.add("drm-device-unavailable"); continue;
      }
      const vendor = vendorId === "0x10de" ? "nvidia" : vendorId === "0x1002" ? "amd" : vendorId === "0x8086" ? "intel" : "other";
      if (devices.some(d => d.pciBusId === bus)) continue;
      const unique = await read("unique_id");
      const hasUnique = /^[0-9a-f]{8,64}$/i.test(unique) && !/^0+$/.test(unique);
      const total = numeric(await read("mem_info_vram_total")), used = numeric(await read("mem_info_vram_used"));
      const percentage = numeric(await read("gpu_busy_percent"));
      devices.push(gpuDeviceSchema.parse({
        id: hasUnique ? `${vendor}:${unique}` : `pci:${bus}:${vendorId}:${deviceId}`,
        identity: hasUnique ? "device" : "pci-slot", name: `${vendor.toUpperCase()} GPU (${vendorId}:${deviceId})`,
        vendor, pciBusId: bus, source: "linux-drm", utilizationPercent: percentage,
        memoryTotalBytes: total, memoryUsedBytes: used, temperatureCelsius: null,
      }));
    } catch { issues.add("drm-device-unavailable"); }
  }
  return gpuTelemetrySchema.parse({ schema: "synora_gpu_telemetry_v1", scope: "host-devices-not-inference-allocation",
    sampledAt, durationMs: Math.max(0, Math.round(io.monotonic() - start)),
    devices: devices.sort((a, b) => a.id.localeCompare(b.id)), issues: [...issues] });
}
