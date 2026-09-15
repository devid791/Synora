import { z } from "zod";

const count = z.number().int().nonnegative().safe();
export const runtimeProgressSchema = z.object({
  scope: z.literal("current_request_observed_work_not_durable_commit"),
  phase: z.string(),
  revision: count,
  prefill_tokens_processed: count,
  prefill_tokens_total: count,
  generated_tokens: count,
  seconds_since_advance: z.number().finite().nonnegative(),
});
export const runtimeStatusSchema = z.object({
  schema: z.literal("axiom_runtime_status_v1"),
  status: z.literal("pass"),
  model: z.string().min(1),
  backend: z.string().min(1),
  loaded: z.boolean(),
  generation_busy: z.boolean(),
  active_request_sequence: count.nullable(),
  active_session_id: z.string().nullable(),
  active_request_progress: runtimeProgressSchema.nullable().optional(),
  http_workers_active: count,
  generation_queue_capacity: count,
  generation_scheduler: z.string(),
  context_window_default: count.positive(),
  context_window_max: count.positive(),
  kv_mode: z.string(),
  session_persistence: z.boolean(),
  session_persistence_pending: count,
  session_persistence_failures: count,
  session_gc_active: z.boolean(),
});
export const resourceStatusSchema = z.object({
  schema: z.literal("axiom_usage_status_v1"),
  status: z.literal("pass"),
  model: z.string().min(1),
  request_sequence: count,
  session_id: z.string(),
  resources_after: z
    .object({
      process_rss_bytes: count,
      process_peak_rss_bytes: count,
      gpu_available: z.boolean(),
      gpu_total_bytes: count,
      gpu_free_bytes: count,
      gpu_used_bytes: count,
      kv_available: z.boolean(),
      kv_submitted_reads: count,
      kv_submitted_writes: count,
      kv_completed_bytes: count,
      kv_io_errors: count,
      kv_committed_tokens: count,
    })
    .refine(
      (r) =>
        !r.gpu_available ||
        (r.gpu_total_bytes > 0 &&
          r.gpu_free_bytes + r.gpu_used_bytes === r.gpu_total_bytes),
      "Invalid GPU memory accounting",
    ),
});
export type BackendProbe<T> = {
  observedAt: number;
  durationMs: number;
  httpStatus: number | null;
} & (
  | { state: "available"; data: T }
  | { state: "unavailable"; code: string; message: string }
);
export const kvStatusSchema = z.object({
  schema: z.literal("axiom_kv_status_v1"),
  status: z.literal("pass"),
  enabled: z.boolean(),
  mode: z.string(),
  committed_tokens: count,
  hot_pages: count,
  page_tokens: count,
  session_id: z.string(),
  session_cold_page_reads: count,
  session_persistence_pending: count,
});
export type BackendStatus =
  | { mode: "inactive"; reason: string }
  | {
      mode: "live";
      endpoint: string;
      runtime: BackendProbe<z.infer<typeof runtimeStatusSchema>>;
      resources: BackendProbe<z.infer<typeof resourceStatusSchema>>;
      kv?: BackendProbe<z.infer<typeof kvStatusSchema>>;
      gpu?: BackendProbe<import("./gpu-telemetry").GpuTelemetry>;
    };
