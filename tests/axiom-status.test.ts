import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { AxiomStatus } from "../src/engine/axiom-status";
import {
  runtimeStatusSchema,
  resourceStatusSchema,
} from "../src/shared/backend-status";

export const runtime = {
  schema: "axiom_runtime_status_v1",
  status: "pass",
  model: "fixture-model",
  backend: "fixture-backend",
  loaded: true,
  generation_busy: true,
  active_session_id: "other-session",
  active_request_sequence: 17,
  http_workers_active: 2,
  generation_queue_capacity: 64,
  generation_scheduler: "fixture-scheduler",
  context_window_default: 262144,
  context_window_max: 1048576,
  kv_mode: "paged_runtime",
  session_persistence: true,
  session_persistence_pending: 1,
  session_persistence_failures: 0,
  session_gc_active: false,
};
export const resources = {
  schema: "axiom_usage_status_v1",
  status: "pass",
  model: "fixture-model",
  request_sequence: 16,
  session_id: "last-completed-session",
  resources_after: {
    process_rss_bytes: 1024 ** 3,
    process_peak_rss_bytes: 2 * 1024 ** 3,
    gpu_available: true,
    gpu_total_bytes: 32 * 1024 ** 3,
    gpu_free_bytes: 4 * 1024 ** 3,
    gpu_used_bytes: 28 * 1024 ** 3,
    kv_available: true,
    kv_submitted_reads: 10,
    kv_submitted_writes: 2,
    kv_completed_bytes: 1000,
    kv_io_errors: 0,
    kv_committed_tokens: 512,
  },
};
async function server(handler: RequestListener) {
  const s = createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  const endpoint = `http://127.0.0.1:${(s.address() as { port: number }).port}/codex/v1`;
  return {
    s,
    endpoint,
    close: async () => {
      s.closeAllConnections();
      await new Promise<void>((r) => s.close(() => r()));
    },
  };
}
test("Backend status uses only independent GETs, concurrent callers share probes and cached observations retain time", async () => {
  const calls: string[] = [];
  const s = await server((req, res) => {
    calls.push(`${req.method} ${req.url}`);
    setTimeout(
      () =>
        res.end(
          JSON.stringify(req.url === "/ops/runtime" ? runtime : resources),
        ),
      10,
    );
  });
  const monitor = new AxiomStatus();
  try {
    const [a, b] = await Promise.all([
      monitor.read(s.endpoint),
      monitor.read(s.endpoint),
    ]);
    assert.deepEqual(a, b);
    assert.deepEqual(await monitor.read(s.endpoint), a);
    assert.deepEqual(calls.sort(), [
      "GET /ops/hardware",
      "GET /ops/kv",
      "GET /ops/runtime",
      "GET /ops/usage",
    ]);
    assert.equal(
      a.mode === "live" && a.kv?.state,
      "unavailable",
      "Malformed/missing KV must not invalidate valid runtime/usage",
    );
    assert.equal(a.mode, "live");
    if (
      a.mode !== "live" ||
      a.runtime.state !== "available" ||
      a.resources.state !== "available"
    )
      throw new Error("Missing actual probes");
    assert.equal(a.runtime.data.generation_busy, true);
    assert.equal(a.resources.data.session_id, "last-completed-session");
    assert.notEqual(
      a.runtime.data.active_session_id,
      a.resources.data.session_id,
    );
    assert.ok(a.runtime.durationMs >= 0);
    assert.equal(a.runtime.httpStatus, 200);
  } finally {
    monitor.dispose();
    await s.close();
  }
});
test("Runtime 503 does not suppress independent resources or claim inference offline, and retry can recover", async () => {
  let fail = true;
  const s = await server((req, res) => {
    if (req.url === "/ops/runtime" && fail) {
      res.writeHead(503);
      res.end("unavailable");
    } else
      res.end(JSON.stringify(req.url === "/ops/runtime" ? runtime : resources));
  });
  const m = new AxiomStatus({ cacheMs: 0 });
  try {
    const a = await m.read(s.endpoint);
    assert.equal(a.mode, "live");
    if (a.mode !== "live") throw new Error();
    assert.equal(a.runtime.state, "unavailable");
    assert.equal(a.runtime.httpStatus, 503);
    assert.equal(a.resources.state, "available");
    assert.equal("offline" in a, false);
    fail = false;
    const b = await m.read(s.endpoint);
    if (b.mode !== "live") throw new Error();
    assert.equal(b.runtime.state, "available");
  } finally {
    m.dispose();
    await s.close();
  }
});
test("Malformed, oversized and redirected status never leaks fields or follows another route", async () => {
  let form = 0;
  const calls: string[] = [];
  const s = await server((req, res) => {
    calls.push(req.url!);
    if (form === 0)
      res.end(
        JSON.stringify({
          ...runtime,
          generation_busy: "no",
          secret: "do-not-return",
        }),
      );
    else if (form === 1) res.end("x".repeat(512 * 1024 + 1));
    else {
      res.writeHead(302, { location: "/other" });
      res.end();
    }
  });
  const m = new AxiomStatus({ cacheMs: 0 });
  try {
    for (form = 0; form < 3; form++) {
      const a = await m.read(s.endpoint);
      if (a.mode !== "live" || a.runtime.state !== "unavailable")
        throw new Error("Accepted malformed response");
      assert.equal(
        a.runtime.code,
        ["STATUS_SCHEMA", "STATUS_TOO_LARGE", "STATUS_HTTP"][form],
      );
      assert.equal(JSON.stringify(a).includes("do-not-return"), false);
      assert.equal("data" in a.runtime, false);
    }
    assert.equal(calls.includes("/other"), false);
  } finally {
    m.dispose();
    await s.close();
  }
});
test(
  "Probe deadline and owned disposal cancel all requests without affecting generation transport",
  { timeout: 5000 },
  async () => {
    let received = 0,
      closed = 0;
    let cancelling = false;
    let arrival!: () => void;
    let allClosed!: () => void;
    const cancelled = new Promise<void>((r) => {
      allClosed = r;
    });
    const arrived = new Promise<void>((r) => {
      arrival = r;
    });
    const s = await server((_req, res) => {
      if (cancelling) {
        if (++received === 4) arrival();
        res.once("close", () => {
          if (++closed === 4) allClosed();
        });
      }
    });
    const m = new AxiomStatus({ timeoutMs: 40, cacheMs: 0 });
    const cancellationMonitor = new AxiomStatus({ timeoutMs: 4000 });
    try {
      const a = await m.read(s.endpoint);
      if (a.mode !== "live" || a.runtime.state !== "unavailable")
        throw new Error();
      assert.equal(a.runtime.code, "STATUS_TIMEOUT_OR_CANCELLED");
      cancelling = true;
      const inFlight = cancellationMonitor.read(s.endpoint);
      await arrived;
      cancellationMonitor.dispose();
      const b = await inFlight;
      if (b.mode !== "live") throw new Error();
      assert.equal(b.runtime.state, "unavailable");
      await assert.rejects(cancellationMonitor.read(s.endpoint), /closed/);
      await cancelled;
      assert.equal(closed, 4);
    } finally {
      m.dispose();
      cancellationMonitor.dispose();
      await s.close();
    }
  },
);
test("Resource availability does not turn zero counters into real GPU measurements; invalid accounting is rejected", () => {
  assert.equal(
    resourceStatusSchema.parse({
      ...resources,
      resources_after: {
        ...resources.resources_after,
        gpu_available: false,
        gpu_total_bytes: 0,
        gpu_used_bytes: 0,
        gpu_free_bytes: 0,
      },
    }).resources_after.gpu_available,
    false,
  );
  assert.throws(() =>
    resourceStatusSchema.parse({
      ...resources,
      resources_after: { ...resources.resources_after, gpu_free_bytes: 1 },
    }),
  );
  assert.throws(() =>
    runtimeStatusSchema.parse({ ...runtime, http_workers_active: -1 }),
  );
  assert.equal(
    "secret" in runtimeStatusSchema.parse({ ...runtime, secret: "stripped" }),
    false,
  );
});
