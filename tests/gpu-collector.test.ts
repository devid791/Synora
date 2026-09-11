import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { gpuCollectorHandler } from "../src/main/gpu-collector-server";
import type { GpuTelemetry } from "../src/shared/gpu-telemetry";
import { parseNvidiaGpus } from "../src/main/gpu-sampler";
const token = "a".repeat(64);
const sample = (): GpuTelemetry => ({ schema: "synora_gpu_telemetry_v1", scope: "host-devices-not-inference-allocation",
  sampledAt: Date.now(), durationMs: 1, devices: parseNvidiaGpus("GPU-12345678, Fixture, 00000000:03:00.0, 0, 16000, 10, 30"), issues: [] });
test("Read-only handler authenticates first and rejects browser/mutating/arbitrary requests", async () => {
  let calls = 0;
  const server = createServer(gpuCollectorHandler(token, async () => { calls++; return sample(); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    for (const [path, method, headers, code] of [
      ["/v1/gpus", "GET", {}, 401], ["/v1/gpus", "GET", { Authorization: "Bearer wrong" }, 401],
      ["/v1/gpus", "POST", { Authorization: `Bearer ${token}` }, 405],
      ["/execute", "GET", { Authorization: `Bearer ${token}` }, 404],
      ["/v1/gpus?command=anything", "GET", { Authorization: `Bearer ${token}` }, 404],
      ["/v1/gpus", "GET", { Authorization: `Bearer ${token}`, Origin: "https://untrusted.invalid" }, 403],
    ] as const) assert.equal((await fetch(url + path, { method, headers })).status, code);
    assert.equal(calls, 0);
    const res = await fetch(url + "/v1/gpus", { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 200); assert.equal(res.headers.get("cache-control"), "no-store");
    assert.equal((await res.json()).devices[0].utilizationPercent, 0);
    assert.equal(calls, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("Concurrent readers share a sensor query and cached sample preserves source time", async () => {
  let calls = 0;
  const server = createServer(gpuCollectorHandler(token, async () => { calls++; await new Promise(r => setTimeout(r, 40)); return sample(); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as any).port}/v1/gpus`;
  try {
    const results = await Promise.all(Array.from({ length: 6 }, async () => (await fetch(url, { headers: { Authorization: `Bearer ${token}` } })).json()));
    assert.equal(calls, 1); assert.equal(new Set(results.map(s => s.sampledAt)).size, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("Failed sensor query returns no old success or internal error/credential detail", async () => {
  const server = createServer(gpuCollectorHandler(token, async () => { throw Error("private path and credentials"); }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const res = await fetch(`http://127.0.0.1:${(server.address() as any).port}/v1/gpus`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(res.status, 503); assert.deepEqual(await res.json(), { error: "GPU_SAMPLE_UNAVAILABLE" });
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
