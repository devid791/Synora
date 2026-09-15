import { z } from "zod";
import { runtimeProgressSchema } from "../shared/backend-status";

const probe = z.object({
  state: z.literal("available"),
  observedAt: z.number().finite(),
  data: z.object({
    schema: z.literal("axiom_runtime_status_v1"),
    model: z.string(),
    loaded: z.literal(true),
    generation_busy: z.literal(true),
    active_session_id: z.string().min(1),
    active_request_sequence: z.number().int().positive().safe(),
    active_request_progress: runtimeProgressSchema,
  }),
});

/** Backend work, not a successful health check, TCP heartbeat or GPU usage.
 * Called only by the owning live engine, using its already-authorized endpoint.
 * Explicit overall deadlines are never extended by this evidence. */
export function hasFreshAxiomProgress(value: unknown, sessionId: string, model: string, now = Date.now()) {
  const result = probe.safeParse(value);
  if (!result.success) return false;
  const { data, observedAt } = result.data, progress = data.active_request_progress;
  const age = now - observedAt;
  return age >= 0 && age <= 15000 && data.active_session_id === sessionId && data.model === model &&
    ["prefill", "decode"].includes(progress.phase) && progress.revision > 0 &&
    progress.prefill_tokens_processed <= progress.prefill_tokens_total &&
    progress.prefill_tokens_processed + progress.generated_tokens > 0 &&
    progress.seconds_since_advance * 1000 + age <= 15000;
}

/** A repeated cached document cannot renew the idle budget indefinitely. */
export class AxiomProgressTracker {
  private last = new Map<string, { sequence: number; revision: number; prefill: number; generated: number }>();
  accept(value: unknown, sessionId: string, model: string, now = Date.now()) {
    if (!hasFreshAxiomProgress(value, sessionId, model, now)) return false;
    const { data } = probe.parse(value), p = data.active_request_progress, old = this.last.get(sessionId);
    if (old && (data.active_request_sequence < old.sequence ||
      (data.active_request_sequence === old.sequence && (p.revision <= old.revision ||
        (p.prefill_tokens_processed <= old.prefill && p.generated_tokens <= old.generated))))) return false;
    this.last.set(sessionId, { sequence: data.active_request_sequence, revision: p.revision,
      prefill: p.prefill_tokens_processed, generated: p.generated_tokens });
    return true;
  }
}
