import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ResourceTelemetry } from "../../src/renderer/ResourceTelemetry";
import type { EngineSnapshot, LocalMetrics, DesktopAPI, AxiomRequestMetrics } from "../../src/shared/contracts";
import type { BackendStatus } from "../../src/shared/backend-status";
import { emptyUsage } from "../../src/shared/session-usage";
import { setLocale } from "../../src/renderer/i18n";
const w = window as any;
if (w.testLocale) setLocale(w.testLocale);
w.calls = 0;
const initialAt = Date.now();
const GiB = 1024 ** 3;
const memory = (used = 12): LocalMetrics => ({
  hostMemory: { state: "available", source: "node:os", observedAt: Date.now(), totalBytes: 16 * GiB, freeBytes: (16 - used) * GiB, nonFreeBytes: used * GiB },
  rssBytes: GiB, observedAt: Date.now(), uptimeSeconds: 10, terminalCount: 0, browserCount: 0, gpu: null, tokens: null,
});
const initial: EngineSnapshot = {
  connection: "live", threadId: "thread-proof", turnId: "turn-proof", status: "running", items: [], agents: [], approval: null, sequence: 1,
  usage: { threadId: "thread-proof", turnId: "turn-proof", observedAt: initialAt,
    value: { modelContextWindow: 100000, last: { ...emptyUsage(), totalTokens: 25000 }, total: { ...emptyUsage(), totalTokens: 450000 } },
    turn: { ...emptyUsage(), totalTokens: 100, inputTokens: 90, outputTokens: 10 } },
  backendRequests: [180, 320, 409].map((v, i) => ({ source: "axiom-response", responseId: `r${i}`, threadId: "thread-proof",
    turnId: "turn-proof", sessionId: "session-proof", model: "fixture-model", profile: "test", observedAt: initialAt + i,
    thinkingTokens: 0, visibleTokens: 40, thinkingBudget: 0, inputTokens: 10200, outputTokens: 40, totalTokens: 10240,
    prefillSeconds: 0.1, decodeSeconds: 0.2, ttftSeconds: 0.11, decodeTokensPerSecond: v, visibleTokensPerSecond: v,
    decodePath: "test-only", speculativeMode: "test-only", prefixHitTokens: 10000, suffixPrefillTokens: 200,
  } satisfies AxiomRequestMetrics)),
};
const backend = (): BackendStatus => ({ mode: "live", endpoint: "http://fixture.invalid/codex/v1",
  runtime: { state: "available", observedAt: Date.now(), durationMs: 2, httpStatus: 200,
    data: { schema: "axiom_runtime_status_v1", status: "pass", model: "fixture-model", backend: "test",
      loaded: true, generation_busy: true, active_request_sequence: 1, active_session_id: "session-proof", http_workers_active: 1,
      generation_queue_capacity: 64, generation_scheduler: "test", context_window_default: 100000, context_window_max: 100000,
      kv_mode: "test", session_persistence: true, session_persistence_pending: 0, session_persistence_failures: 0, session_gc_active: false } },
  resources: { state: "available", observedAt: Date.now(), durationMs: 2, httpStatus: 200,
    data: { schema: "axiom_usage_status_v1", status: "pass", model: "fixture-model", request_sequence: 8, session_id: "other-session",
      resources_after: { process_rss_bytes: GiB, process_peak_rss_bytes: GiB, gpu_available: true, gpu_total_bytes: 32 * GiB,
        gpu_free_bytes: 8 * GiB, gpu_used_bytes: 24 * GiB, kv_available: false, kv_submitted_reads: 0, kv_submitted_writes: 0,
        kv_completed_bytes: 0, kv_io_errors: 0, kv_committed_tokens: 0 } } },
});
const api: Pick<DesktopAPI, "backendStatus"> = { backendStatus: async () => {
  w.calls++;
  if (w.failBackend) return { ok: false, error: { code: "TEST_OFFLINE", message: "Controlled telemetry offline" } };
  return { ok: true, value: w.externalProvider ? { mode: "inactive", reason: "External provider" } : backend() };
} };
function App() {
  const [engine, setEngine] = useState(initial), [metrics, setMetrics] = useState<LocalMetrics | null>(memory()), [generation, setGeneration] = useState(0);
  w.updateMemory = (used: number) => setMetrics(memory(used));
  w.clearMemory = () => setMetrics(null);
  w.compact = () => setEngine({ ...initial, compactions: [{ id: "c", threadId: initial.threadId!, turnId: initial.turnId!, status: "running", startedAt: Date.now() } as any] });
  w.overflow = () => setEngine({ ...initial, usage: { ...initial.usage!, value: { ...initial.usage!.value, last: { ...emptyUsage(), totalTokens: 110000 } } } });
  w.switchProvider = () => { w.externalProvider = true; setEngine({ ...initial, threadId: "external", backendRequests: [], usage: undefined }); setGeneration(v => v + 1); };
  return <ResourceTelemetry key={generation} api={api} engine={engine} metrics={metrics} axiom={!w.externalProvider} />;
}
createRoot(document.getElementById("root")!).render(<App />);
