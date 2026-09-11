import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { GpuTelemetry } from "../../src/renderer/GpuTelemetry";
import type { GpuTelemetry as Sample } from "../../src/shared/gpu-telemetry";
const w = window as any;
function App() {
  const [data, setData] = useState<Sample>({ schema: "synora_gpu_telemetry_v1", scope: "host-devices-not-inference-allocation", sampledAt: Date.now(), durationMs: 1, devices: [], issues: [] });
  const [offline, setOffline] = useState(false), [now, setNow] = useState(Date.now());
  w.sample = (devices: Sample["devices"]) => { setOffline(false); setData({ ...data, sampledAt: Date.now(), devices }); setNow(Date.now()); };
  w.stale = () => setNow(Date.now() + 20000); w.offline = () => setOffline(true);
  return <div className="resource-telemetry"><GpuTelemetry now={now} probe={offline ? { state: "unavailable", code: "TEST", message: "Controlled offline", observedAt: now, durationMs: 1, httpStatus: null } : { state: "available", data, observedAt: Date.now(), durationMs: 1, httpStatus: 200 }} /></div>;
}
createRoot(document.getElementById("root")!).render(<App />);
