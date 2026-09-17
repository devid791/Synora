import { z } from "zod";
import { sampleClockNow, type BackendProbe } from "./backend-status";
import type { GpuTelemetry } from "./gpu-telemetry";
import { sampleStale } from "./resource-telemetry";

const id = z.string().min(1).max(256);
const bytes = z.number().int().nonnegative().safe();
const memoryKind = z.enum(["dedicated", "unified", "unknown"]);
export const hardwareSchema = z.object({
  schema: z.literal("axiom_hardware_v1"),
  sampledAt: bytes,
  durationMs: bytes,
  topology: z.enum(["single-node", "cluster", "unknown"]),
  nodes: z.array(z.object({
    id, name: id, state: z.enum(["online", "offline", "unavailable"]), sampledAt: bytes,
  }).strict()).max(64),
  devices: z.array(z.object({
    id, nodeId: id, name: id, vendor: z.enum(["nvidia", "amd", "intel", "apple", "other"]),
    uuid: id.nullable(), pciBusId: z.string().regex(/^[0-9a-f]{4,8}:[0-9a-f]{2}:[0-9a-f]{2}\.[0-7]$/i).nullable(),
    memoryKind, memoryPoolId: id, addressableMemoryBytes: bytes.positive().nullable(),
    unifiedAddressing: z.boolean().nullable(), hardwareCoherentHostAccess: z.boolean().nullable(),
    numaNode: bytes.nullable(), utilizationPercent: z.number().min(0).max(100).nullable(),
    temperatureCelsius: z.number().min(-100).max(250).nullable(),
    source: id,
  }).strict()).max(64),
  memoryPools: z.array(z.object({
    id, nodeId: id, kind: z.enum(["dedicated", "unified", "system", "unknown"]),
    totalBytes: bytes.positive().nullable(), usedBytes: bytes.nullable(), source: id,
  }).strict().refine(p => p.totalBytes === null || p.usedBytes === null || p.usedBytes <= p.totalBytes,
    "Memory usage exceeds pool capacity")).max(128),
  links: z.array(z.object({
    from: id, to: id, kind: z.enum(["nvlink", "cuda-peer-access", "pcie", "rdma", "tcp", "unknown"]),
    accessible: z.boolean().nullable(),
  }).strict()).max(2016),
  execution: z.object({
    mode: z.enum(["single-device", "multi-device", "cluster", "cpu", "unknown"]),
    deviceIds: z.array(id).max(64), source: id,
    scope: z.literal("loaded-model-not-per-conversation"),
  }).strict(),
  issues: z.array(z.string().min(1).max(160)).max(256),
}).strict().superRefine((h, ctx) => {
  const reject = (message: string) => ctx.addIssue({code: z.ZodIssueCode.custom, message});
  const nodes = new Map(h.nodes.map(n => [n.id, n]));
  const devices = new Map(h.devices.map(d => [d.id, d]));
  const pools = new Map(h.memoryPools.map(p => [p.id, p]));
  if (nodes.size !== h.nodes.length || devices.size !== h.devices.length || pools.size !== h.memoryPools.length)
    reject("Duplicate hardware identities");
  if (h.topology === "single-node" && nodes.size !== 1) reject("Single-node topology must contain one node");
  if (h.topology === "cluster" && nodes.size < 2) reject("Cluster requires multiple reported nodes");
  for (const p of h.memoryPools) if (!nodes.has(p.nodeId)) reject("Unknown pool node");
  for (const d of h.devices) {
    const pool = pools.get(d.memoryPoolId);
    if (!nodes.has(d.nodeId) || !pool || pool.nodeId !== d.nodeId || pool.kind !== d.memoryKind)
      reject("Invalid device memory ownership");
  }
  const assignedNodes = new Set<string>();
  for (const id of h.execution.deviceIds) {
    const d = devices.get(id);
    if (!d || nodes.get(d.nodeId)?.state !== "online") reject("Assignment references unavailable device");
    else assignedNodes.add(d.nodeId);
  }
  if (new Set(h.execution.deviceIds).size !== h.execution.deviceIds.length) reject("Duplicate assigned device");
  if (h.execution.mode === "single-device" && h.execution.deviceIds.length !== 1) reject("Invalid single-device assignment");
  if (h.execution.mode === "multi-device" && (h.execution.deviceIds.length < 2 || assignedNodes.size !== 1)) reject("Invalid multi-device assignment");
  if (h.execution.mode === "cluster" && (assignedNodes.size < 2 || h.topology !== "cluster")) reject("Unproven clustered assignment");
  if ((h.execution.mode === "cpu" || h.execution.mode === "unknown") && h.execution.deviceIds.length) reject("Unexpected GPU assignment");
  const links = new Set<string>();
  for (const l of h.links) {
    const key = [l.from, l.to].sort().join("\0") + l.kind;
    if (l.from === l.to || !devices.has(l.from) || !devices.has(l.to) || links.has(key)) reject("Invalid or duplicate hardware link");
    links.add(key);
  }
});
export type Hardware = z.infer<typeof hardwareSchema>;

/** One physical pool is counted once even if CPU and several GPUs share it.
 * Unknown or offline pools never become invented zero or a complete total. */
export function memorySummary(h: Hardware, now: number = Date.now()) {
  let totalBytes = 0, usedBytes = 0;
  let complete = h.memoryPools.length > 0 && !sampleStale(h.sampledAt, now) && h.nodes.every(n => n.state === "online" && !sampleStale(n.sampledAt, now));
  for (const p of h.memoryPools) {
    if (h.nodes.find(n => n.id === p.nodeId)?.state !== "online" || p.totalBytes === null || p.usedBytes === null) {
      complete = false; continue;
    }
    totalBytes += p.totalBytes; usedBytes += p.usedBytes;
    if (!Number.isSafeInteger(totalBytes) || !Number.isSafeInteger(usedBytes)) return { totalBytes: null, usedBytes: null, complete: false };
  }
  return { totalBytes: complete ? totalBytes : null, usedBytes: complete ? usedBytes : null, complete };
}

/** Compatibility projection for existing meters; topology stays authoritative. */
export function hardwareGpuProbe(probe: BackendProbe<Hardware>): BackendProbe<GpuTelemetry> {
  if (probe.state === "unavailable") return probe;
  const h = probe.data;
  const timestamps = [h.sampledAt, ...h.nodes.filter(n => n.state === "online").map(n => n.sampledAt)];
  const now = sampleClockNow(probe, probe.observedAt);
  return {...probe, data: {
    schema: "synora_gpu_telemetry_v1", scope: "host-devices-not-inference-allocation",
    // Preserve future timestamps as invalid rather than hiding clock skew with min().
    sampledAt: timestamps.some(at => at > now + 1000)
      ? Math.max(...timestamps) : Math.min(...timestamps),
    durationMs: h.durationMs,
    devices: h.devices.filter(d => h.nodes.find(n => n.id === d.nodeId)?.state === "online").map(d => {
      const pool = h.memoryPools.find(p => p.id === d.memoryPoolId)!;
      return { id: d.id, identity: "device", name: d.name, vendor: d.vendor === "apple" ? "other" : d.vendor,
        nodeId: d.nodeId, memoryPoolId: d.memoryPoolId, memoryKind: d.memoryKind,
        pciBusId: d.pciBusId, source: "axiom-hardware", utilizationPercent: d.utilizationPercent,
        memoryTotalBytes: pool.totalBytes, memoryUsedBytes: pool.usedBytes,
        temperatureCelsius: d.temperatureCelsius };
    }),
    issues: h.issues.length || h.nodes.some(n => n.state !== "online") ? ["device-sensor-unavailable"] : [],
  }};
}
