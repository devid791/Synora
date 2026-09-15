import { createRoot } from "react-dom/client";
import { useCallback, useState } from "react";
import { StatusBar } from "../../src/renderer/StatusBar";
import { emptyEngine } from "../../src/renderer/engine-state";
import { setLocale } from "../../src/renderer/i18n";
import { emptyUsage } from "../../src/shared/session-usage";
import type { BackendStatus } from "../../src/shared/backend-status";
import type { GpuDevice } from "../../src/shared/gpu-telemetry";
import type {
  DesktopAPI,
  EngineSnapshot,
  LocalMetrics,
} from "../../src/shared/contracts";

const w = window as any,
  GiB = 1024 ** 3;
if (w.testLocale) setLocale(w.testLocale);
w.calls = 0;
w.overlays = [];
w.age = 0;
w.devices = [
  {
    id: "gpu-first",
    identity: "device",
    name: "NVIDIA GeForce RTX 5090",
    vendor: "nvidia",
    pciBusId: "0000:01:00.0",
    source: "nvidia-smi",
    utilizationPercent: 38,
    memoryUsedBytes: 29.4 * GiB,
    memoryTotalBytes: 31.8 * GiB,
    temperatureCelsius: 47,
  },
] satisfies GpuDevice[];
const unavailable = {
  state: "unavailable" as const,
  observedAt: Date.now(),
  durationMs: 0,
  httpStatus: null,
  code: "TEST_ONLY",
  message: "Controlled fixture unavailable",
};
const backend = (): BackendStatus => {
  const at = Date.now() - w.age;
  return {
    mode: "live",
    endpoint: "http://fixture.invalid/v1",
    runtime: {
      state: "available",
      observedAt: at,
      durationMs: 1,
      httpStatus: 200,
      data: {
        schema: "axiom_runtime_status_v1",
        status: "pass",
        model: "fixture-model",
        backend: "test",
        loaded: true,
        generation_busy: !!w.backendBusy,
        active_request_sequence: 1,
        active_session_id: "test-session",
        http_workers_active: 1,
        generation_queue_capacity: 64,
        generation_scheduler: "test",
        context_window_default: 100000,
        context_window_max: 100000,
        kv_mode: "test",
        session_persistence: true,
        session_persistence_pending: 0,
        session_persistence_failures: 0,
        session_gc_active: false,
      },
    },
    gpu: w.noCollector ? { ...unavailable, code: "GPU_NOT_CONFIGURED" } : w.gpuFailed ? unavailable : {
      state: "available",
      observedAt: at,
      durationMs: 1,
      httpStatus: 200,
      data: {
        schema: "synora_gpu_telemetry_v1",
        scope: "host-devices-not-inference-allocation",
        sampledAt: at,
        durationMs: 1,
        devices: w.devices,
        issues: w.issues ?? [],
      },
    },
    kv: {
      state: "available",
      observedAt: at,
      durationMs: 1,
      httpStatus: 200,
      data: {
        schema: "axiom_kv_status_v1",
        status: "pass",
        enabled: true,
        mode: "test",
        committed_tokens: 8783,
        hot_pages: 256,
        page_tokens: 16,
        session_id: "test-session",
        session_cold_page_reads: 0,
        session_persistence_pending: 0,
      },
    },
    resources: w.noHistory
      ? unavailable
      : {
          state: "available",
          observedAt: at,
          durationMs: 1,
          httpStatus: 200,
          data: {
            schema: "axiom_usage_status_v1",
            status: "pass",
            model: "fixture-model",
            request_sequence: 8,
            session_id: "other-session",
            resources_after: {
              process_rss_bytes: GiB,
              process_peak_rss_bytes: GiB,
              gpu_available: true,
              gpu_total_bytes: 32 * GiB,
              gpu_free_bytes: 8 * GiB,
              gpu_used_bytes: 24 * GiB,
              kv_available: false,
              kv_submitted_reads: 0,
              kv_submitted_writes: 0,
              kv_completed_bytes: 0,
              kv_io_errors: 0,
              kv_committed_tokens: 0,
            },
          },
        },
  };
};
const api: Pick<DesktopAPI, "backendStatus"> = {
  backendStatus: async () => {
    w.calls++;
    if (w.hold)
      await new Promise<void>((resolve) => {
        w.release = resolve;
      });
    return w.fail
      ? {
          ok: false,
          error: { code: "TEST_OFFLINE", message: "Controlled offline" },
        }
      : { ok: true, value: backend() };
  },
};
const at = Date.now();
const initial: EngineSnapshot = {
  ...emptyEngine,
  connection: "live",
  status: "completed",
  threadId: "test-thread",
  turnId: "test-turn",
  appServer: { phase: "ready", attempts: 0, pid: 123 },
  startedAt: at - 1000,
  completedAt: at,
  firstDeltaAt: at - 900,
  items: [
    {
      id: "message",
      type: "agentMessage",
      text: "A controlled text response.",
      phase: null,
      memoryCitation: null,
      delivery: null,
      questions: null,
    },
  ],
  usage: {
    threadId: "test-thread",
    turnId: "test-turn",
    observedAt: at,
    value: {
      modelContextWindow: 262144,
      last: {
        ...emptyUsage(),
        inputTokens: 90,
        outputTokens: 10,
        totalTokens: 100,
      },
      total: { ...emptyUsage(), totalTokens: 450000 },
    },
    turn: { ...emptyUsage(), totalTokens: 100 },
  },
  backendRequests: [
    {
      source: "axiom-response",
      responseId: "r1",
      threadId: "test-thread",
      turnId: "test-turn",
      sessionId: "test-session",
      model: "fixture-model",
      profile: "test",
      observedAt: at,
      thinkingTokens: 0,
      visibleTokens: 40,
      thinkingBudget: 0,
      inputTokens: 10200,
      outputTokens: 40,
      totalTokens: 10240,
      prefillSeconds: 0.1,
      decodeSeconds: 0.2,
      ttftSeconds: 0.11,
      decodeTokensPerSecond: 180,
      visibleTokensPerSecond: 180,
      decodePath: "test-only",
      speculativeMode: "test-only",
      prefixHitTokens: 10000,
      suffixPrefillTokens: 200,
    },
  ],
};
const memory: LocalMetrics = {
  rssBytes: 263 * 1024 ** 2,
  observedAt: at,
  uptimeSeconds: 10,
  terminalCount: 2,
  browserCount: 0,
  gpu: null,
  tokens: null,
};
function Fixture() {
  const [platform, setPlatform] = useState("darwin");
  w.setPlatform = setPlatform;
  const [engine, setEngine] = useState(initial),
    [connection, setConnection] = useState(initial);
  const [mode, setMode] = useState("axiom"),
    [metrics, setMetrics] = useState<LocalMetrics | null>(memory);
  const [overlay, setOverlay] = useState(false),
    [mounted, setMounted] = useState(true);
  const onOverlayChange = useCallback((open: boolean) => {
    w.overlays.push(open);
    setOverlay(open);
  }, []);
  w.patchEngine = (patch: Partial<EngineSnapshot>) =>
    setEngine((v) => ({ ...v, ...patch }));
  w.setPhase = (phase: NonNullable<EngineSnapshot["appServer"]>["phase"]) =>
    setConnection({
      ...initial,
      appServer: { phase, attempts: 1, message: "Controlled connection state" },
    });
  w.setMode = setMode;
  w.setMetrics = setMetrics;
  w.setMounted = setMounted;
  w.setLocale = setLocale;
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        position: "fixed",
        inset: 0,
        minWidth: 0,
      }}
    >
      <div
        style={{ flex: 1, minHeight: 0, padding: 24 }}
        data-native-browser-hidden={overlay}
      >
        <p>Controlled status-bar fixture · no live inference</p>
        <button>Background action</button>
      </div>
      {mounted && (
        <StatusBar
          api={api}
          engine={connection}
          conversationEngine={engine}
          live={mode !== "simulation"}
          axiom={mode === "axiom"}
          providerLabel={
            mode === "axiom" ? "Axiom" : "External provider with a long name"
          }
          providerKey={mode}
          metrics={metrics}
          platform={platform}
          protocolVersion="0.153.4"
          onOverlayChange={onOverlayChange}
        />
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
