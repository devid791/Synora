import { createRoot } from "react-dom/client";
import { BackendStatus } from "../../src/renderer/BackendStatus";
import type { DesktopAPI } from "../../src/shared/contracts";
let call = 0;
const api: Pick<DesktopAPI, "backendStatus"> = {
  backendStatus: async () => {
    call++;
    if (call === 1)
      return {
        ok: true,
        value: {
          mode: "inactive",
          reason: "Fixture simulator: no backend queried.",
        },
      };
    if (call === 3)
      return {
        ok: false,
        error: {
          code: "FIXTURE_FAILURE",
          message: "Fixture transport error; retry available.",
        },
      };
    const observedAt = 1788921000000;
    return {
      ok: true,
      value: {
        mode: "live",
        endpoint: "http://fixture.invalid/codex/v1",
        runtime: {
          state: "available",
          observedAt,
          durationMs: 3,
          httpStatus: 200,
          data: {
            schema: "axiom_runtime_status_v1",
            status: "pass",
            model: "fixture-model",
            backend: "fixture-backend",
            loaded: true,
            generation_busy: true,
            active_session_id: "active-fixture-session",
            active_request_sequence: 17,
            http_workers_active: 2,
            generation_queue_capacity: 64,
            generation_scheduler: "fixture-scheduler",
            context_window_default: 262144,
            context_window_max: 1048576,
            kv_mode: "paged_runtime",
            session_persistence: true,
            session_persistence_pending: 0,
            session_persistence_failures: 0,
            session_gc_active: false,
          },
        },
        resources: {
          state: "unavailable",
          observedAt,
          durationMs: 3,
          httpStatus: 503,
          code: "STATUS_HTTP",
          message:
            "Fixture resource endpoint unavailable; model state is not inferred.",
        },
      },
    };
  },
};
createRoot(document.getElementById("root")!).render(
  <BackendStatus api={api} />,
);
