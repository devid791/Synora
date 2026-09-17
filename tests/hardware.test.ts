import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { hardwareSchema, hardwareGpuProbe, memorySummary, type Hardware } from "../src/shared/hardware";
import { gpuProbeState, gpuTelemetrySchema } from "../src/shared/gpu-telemetry";
import { HardwareTelemetry } from "../src/renderer/HardwareTelemetry";
import { AxiomStatus } from "../src/engine/axiom-status";
import { createServer } from "node:http";

const at = 100_000;
const GiB = 1024 ** 3;
function fixture(unified = false): Hardware {
  return {
    schema: "axiom_hardware_v1", sampledAt: at, durationMs: 2, topology: "single-node",
    nodes: [{id: "node:one", name: "Executor", state: "online", sampledAt: at}],
    devices: [{id: "gpu:one", nodeId: "node:one", name: unified ? "Unified GPU" : "Discrete GPU", vendor: "nvidia",
      uuid: "GPU-fixture", pciBusId: "00000000:01:00.0", memoryKind: unified ? "unified" : "dedicated",
      memoryPoolId: "pool:one", addressableMemoryBytes: 32 * GiB, unifiedAddressing: true,
      hardwareCoherentHostAccess: unified, numaNode: 0, utilizationPercent: 0, temperatureCelsius: 45, source: "controlled-fixture"}],
    memoryPools: [{id: "pool:one", nodeId: "node:one", kind: unified ? "unified" : "dedicated", totalBytes: 32 * GiB, usedBytes: 16 * GiB, source: "controlled-fixture"}],
    links: [], execution: {mode: "single-device", deviceIds: ["gpu:one"], source: "runtime-model", scope: "loaded-model-not-per-conversation"}, issues: [],
  };
}
function projected(h: Hardware) { return hardwareGpuProbe({ state: "available", data: hardwareSchema.parse(h), observedAt: at, durationMs: 2, httpStatus: 200 }); }
test("Single GPU preserves measured zero, identity, extended PCI domain and runtime assignment", () => {
  const p = projected(fixture());
  assert.equal(gpuProbeState(p, at), "available");
  if (p.state !== "available") throw Error();
  assert.equal(gpuTelemetrySchema.parse(p.data).devices[0].utilizationPercent, 0);
  assert.equal(p.data.devices[0].memoryKind, "dedicated", "CUDA UVA is not physically shared memory");
});
test("Multiple GPUs sharing unified RAM count their physical pool once", () => {
  const h = fixture(true);
  h.devices.push({...h.devices[0], id: "gpu:two", uuid: "GPU-two"});
  h.execution = {...h.execution, mode: "multi-device", deviceIds: h.devices.map(d => d.id)};
  hardwareSchema.parse(h);
  assert.deepEqual(memorySummary(h, at), {totalBytes: 32 * GiB, usedBytes: 16 * GiB, complete: true});
  const html = renderToStaticMarkup(createElement(HardwareTelemetry, {hardware: h, now: at}));
  assert.equal((html.match(/data-memory-pool=/g) ?? []).length, 1);
  assert.match(html, /Unified memory/);
  assert.doesNotMatch(html, /Dedicated VRAM/);
});
test("Distinct GPU pools sum once and do not imply multi-GPU execution", () => {
  const h = fixture();
  h.devices.push({...h.devices[0], id: "gpu:two", uuid: "GPU-two", memoryPoolId: "pool:two"});
  h.memoryPools.push({...h.memoryPools[0], id: "pool:two"});
  hardwareSchema.parse(h);
  assert.equal(memorySummary(h, at).totalBytes, 64 * GiB);
  assert.equal(h.execution.deviceIds.length, 1);
});
test("Reported cluster validates node ownership, distributed assignment and link endpoints", () => {
  const h = fixture();
  h.topology = "cluster";
  h.nodes.push({...h.nodes[0], id: "node:two", name: "Worker"});
  h.devices.push({...h.devices[0], id: "gpu:two", nodeId: "node:two", memoryPoolId: "pool:two"});
  h.memoryPools.push({...h.memoryPools[0], id: "pool:two", nodeId: "node:two"});
  h.execution = {...h.execution, mode: "cluster", deviceIds: h.devices.map(d => d.id)};
  h.links.push({from: "gpu:one", to: "gpu:two", kind: "rdma", accessible: true});
  hardwareSchema.parse(h);
  assert.equal(memorySummary(h, at).totalBytes, 64 * GiB);
  h.nodes[1].state = "offline";
  assert.equal(hardwareSchema.safeParse(h).success, false, "Offline worker cannot be assigned as live");
  h.execution = {...h.execution, mode: "unknown", deviceIds: []};
  const p = projected(h);
  assert.equal(p.state === "available" && p.data.devices.length, 1);
  assert.equal(memorySummary(h, at).complete, false);
});
test("Stale, future and missing measurements never turn into fresh zeros", () => {
  const h = fixture();
  assert.equal(gpuProbeState(projected(h), at + 8000), "stale");
  assert.equal(memorySummary(h, at + 8000).complete, false);
  h.nodes[0].sampledAt = at + 5000;
  assert.equal(gpuProbeState(projected(h), at), "stale");
  h.nodes[0].sampledAt = at;
  h.memoryPools[0].usedBytes = null;
  assert.equal(memorySummary(h, at).usedBytes, null);
  const html = renderToStaticMarkup(createElement(HardwareTelemetry, {hardware: h, now: at + 8000}));
  assert.doesNotMatch(html, /data-gpu-live=/);
  assert.match(html, /Stale/);
});
test("Malformed hardware reports are rejected, never partially reinterpreted", () => {
  const changes: Array<(h: Hardware) => void> = [
    h => h.devices.push({...h.devices[0]}), h => h.memoryPools.push({...h.memoryPools[0]}),
    h => {h.devices[0].nodeId = "missing";}, h => {h.devices[0].memoryPoolId = "missing";},
    h => {h.devices[0].memoryKind = "unified";}, h => {h.memoryPools[0].usedBytes = 33 * GiB;},
    h => {h.execution.mode = "cluster";}, h => {h.execution.deviceIds = ["invented"];},
    h => {h.topology = "cluster";}, h => {h.links = [{from: "gpu:one", to: "missing", kind: "nvlink", accessible: true}];},
  ];
  for (const change of changes) { const h = fixture(); change(h); assert.equal(hardwareSchema.safeParse(h).success, false); }
});
test("Enumeration failure is unavailable, not no GPU; no-pool total is unknown", () => {
  const h = fixture(); h.devices = []; h.memoryPools = []; h.execution = {...h.execution, mode: "unknown", deviceIds: []};
  h.issues = ["cuda-enumeration-unavailable"];
  assert.equal(gpuProbeState(projected(h), at), "unavailable");
  assert.equal(memorySummary(h, at).complete, false);
});
test("Hardware request reuses provider bearer, performs only same-origin GETs and survives an unsupported endpoint", async () => {
  let unsupported = false;
  const calls: string[] = [];
  const server = createServer((req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-hardware-token");
    calls.push(`${req.method} ${req.url}`);
    if (req.url === "/ops/hardware" && !unsupported) res.end(JSON.stringify(fixture()));
    else { res.writeHead(404); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(server.address() as {port:number}).port}/codex/v1`;
  const monitor = new AxiomStatus({cacheMs: 0});
  try {
    const a = await monitor.read(endpoint, "test-hardware-token");
    assert.equal(a.mode === "live" && a.hardware?.state, "available");
    assert.equal(a.mode === "live" && a.gpu?.state, "available");
    unsupported = true;
    const b = await monitor.read(endpoint, "test-hardware-token");
    assert.equal(b.mode === "live" && b.hardware?.httpStatus, 404);
    assert.equal(b.mode === "live" && b.gpu?.state, "unavailable");
    assert.ok(calls.every(c => /^GET \/ops\/(runtime|usage|kv|hardware)$/.test(c)));
  } finally { monitor.dispose(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); }
});
