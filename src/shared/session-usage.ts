import { z } from "zod";
import type { ThreadTokenUsage } from "../protocol/codex-0.153.4/v2/ThreadTokenUsage";
import type { TokenUsageBreakdown } from "../protocol/codex-0.153.4/v2/TokenUsageBreakdown";

const count = z.number().int().nonnegative().safe();
export const tokenBreakdownSchema = z
  .object({
    totalTokens: count,
    inputTokens: count,
    cachedInputTokens: count,
    cacheWriteInputTokens: count,
    outputTokens: count,
    reasoningOutputTokens: count,
  })
  .strict();
export const sessionUsageSchema = z
  .object({
    threadId: z.string().min(1),
    turnId: z.string().min(1),
    observedAt: count,
    value: z
      .object({
        total: tokenBreakdownSchema,
        last: tokenBreakdownSchema,
        modelContextWindow: count.positive().nullable(),
      })
      .strict(),
    turn: tokenBreakdownSchema.optional(),
  })
  .strict();
export type SessionUsage = z.infer<typeof sessionUsageSchema>;
export const emptyUsage = (): TokenUsageBreakdown => ({
  totalTokens: 0,
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
});

/** Core totals are authoritative: subtract a known turn-start baseline, never
 * add repeated snapshots or treat context occupancy as cumulative consumption. */
export function captureUsage(
  threadId: string,
  turnId: string,
  value: ThreadTokenUsage,
  observedAt: number,
  baseline?: TokenUsageBreakdown,
): SessionUsage {
  let turn: TokenUsageBreakdown | undefined;
  if (
    baseline &&
    Object.keys(baseline).every(
      (k) =>
        value.total[k as keyof TokenUsageBreakdown] >=
        baseline[k as keyof TokenUsageBreakdown],
    )
  )
    turn = Object.fromEntries(
      Object.keys(baseline).map((k) => [
        k,
        value.total[k as keyof TokenUsageBreakdown] -
          baseline[k as keyof TokenUsageBreakdown],
      ]),
    ) as TokenUsageBreakdown;
  return sessionUsageSchema.parse({
    threadId,
    turnId,
    value,
    observedAt,
    ...(turn ? { turn } : {}),
  });
}
