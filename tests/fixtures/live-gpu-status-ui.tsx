import { createRoot } from "react-dom/client";
import { useState } from "react";
import { LiveGpuStatus } from "../../src/renderer/LiveGpuStatus";
import { emptyEngine } from "../../src/renderer/engine-state";
import type { BackendStatus } from "../../src/shared/backend-status";
import type { EngineSnapshot } from "../../src/shared/contracts";
const w = window as any;
function Fixture() {
  const [status, setStatus] = useState<EngineSnapshot["status"]>("completed");
  const [backend, setBackend] = useState<BackendStatus | null>(null);
  const [now, setNow] = useState(10000);
  const [error, setError] = useState("");
  w.gpu = { setStatus, setBackend, setNow, setError };
  return <LiveGpuStatus engine={{ ...emptyEngine, status }} backend={backend} now={now} error={error} />;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
