import { z } from "zod";
import type { AxiomRequestMetrics } from "../shared/contracts";

const id = z.string().min(1).max(512);
const count = z.number().int().nonnegative().safe();
const seconds = z.number().finite().nonnegative();
const identity = z.object({ session_id: id, thread_id: id, turn_id: id });
const completed = z.object({
  type: z.literal("response.completed"),
  response: z.object({
    id,
    status: z.literal("completed"),
    session_id: id,
    thread_id: id,
    turn_id: id,
    model: id,
    usage: z.object({
      input_tokens: count,
      output_tokens: count,
      total_tokens: count,
    }),
    axiom: z.object({
      session_id: id,
      reasoning_effort: id,
      thinking_tokens: count,
      visible_output_tokens: count,
      thinking_budget: count,
      prefill_seconds: seconds,
      decode_seconds: seconds,
      ttft_seconds: seconds,
      decode_tokens_per_second: seconds,
      visible_tokens_per_second: seconds,
      decode_path: id,
      speculative_mode_effective: id,
      prefix_hit_tokens: count,
      suffix_prefill_tokens: count,
    }),
  }),
});
export const storedAxiomMetrics = z
  .object({
    source: z.literal("axiom-response"),
    responseId: id,
    sessionId: id,
    threadId: id,
    turnId: id,
    model: id,
    profile: id,
    observedAt: count,
    thinkingTokens: count,
    visibleTokens: count,
    thinkingBudget: count,
    inputTokens: count,
    outputTokens: count,
    totalTokens: count,
    prefillSeconds: seconds,
    decodeSeconds: seconds,
    ttftSeconds: seconds,
    decodeTokensPerSecond: seconds,
    visibleTokensPerSecond: seconds,
    decodePath: id,
    speculativeMode: id,
    prefixHitTokens: count,
    suffixPrefillTokens: count,
  })
  .strict();

export function requestIdentity(body: Buffer) {
  try {
    return identity.parse(JSON.parse(body.toString("utf8")).client_metadata);
  } catch {
    return undefined;
  }
}

/** Bounded side-channel observer. Its output never replaces Core/SSE frames. */
export class AxiomTelemetryObserver {
  private decoder = new TextDecoder("utf-8", { fatal: true });
  private pending = "";
  private data: string[] = [];
  private bytes = 0;
  private disabled = false;
  private emitted = new Set<string>();
  constructor(
    private expected: {
      session_id: string;
      thread_id: string;
      turn_id: string;
      model: string;
    },
    private onMetrics: (value: AxiomRequestMetrics) => void,
    private maxFrameBytes = 16 * 1024 * 1024,
  ) {}
  write(chunk: Uint8Array) {
    if (this.disabled) return;
    try {
      this.pending += this.decoder.decode(chunk, { stream: true });
      if (Buffer.byteLength(this.pending) + this.bytes > this.maxFrameBytes) {
        this.disabled = true;
        this.pending = "";
        this.data = [];
        return;
      }
      for (
        let end = this.pending.indexOf("\n");
        end >= 0;
        end = this.pending.indexOf("\n")
      ) {
        const line = this.pending.slice(0, end).replace(/\r$/, "");
        this.pending = this.pending.slice(end + 1);
        if (line === "") {
          this.frame(this.data.join("\n"));
          this.data = [];
          this.bytes = 0;
        } else if (line.startsWith("data:")) {
          const value = line.slice(5).replace(/^ /, "");
          this.data.push(value);
          this.bytes += Buffer.byteLength(value);
        }
      }
    } catch {
      // Malformed/missing telemetry is unavailable, not an invented zero or
      // a reason to change/drop the actual provider response.
      this.disabled = true;
      this.pending = "";
      this.data = [];
    }
  }
  private frame(data: string) {
    if (!data || data === "[DONE]") return;
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      return;
    }
    const result = completed.safeParse(value);
    if (!result.success) return;
    const r = result.data.response,
      a = r.axiom;
    if (
      r.session_id !== this.expected.session_id ||
      r.thread_id !== this.expected.thread_id ||
      r.turn_id !== this.expected.turn_id ||
      r.model !== this.expected.model ||
      a.session_id !== r.session_id ||
      this.emitted.has(r.id)
    )
      return;
    if (
      a.thinking_tokens + a.visible_output_tokens !== r.usage.output_tokens ||
      r.usage.input_tokens + r.usage.output_tokens !== r.usage.total_tokens
    )
      return;
    this.emitted.add(r.id);
    this.onMetrics({
      source: "axiom-response",
      responseId: r.id,
      sessionId: r.session_id,
      threadId: r.thread_id,
      turnId: r.turn_id,
      model: r.model,
      observedAt: Date.now(),
      profile: a.reasoning_effort,
      thinkingTokens: a.thinking_tokens,
      visibleTokens: a.visible_output_tokens,
      thinkingBudget: a.thinking_budget,
      inputTokens: r.usage.input_tokens,
      outputTokens: r.usage.output_tokens,
      totalTokens: r.usage.total_tokens,
      prefillSeconds: a.prefill_seconds,
      decodeSeconds: a.decode_seconds,
      ttftSeconds: a.ttft_seconds,
      decodeTokensPerSecond: a.decode_tokens_per_second,
      visibleTokensPerSecond: a.visible_tokens_per_second,
      decodePath: a.decode_path,
      speculativeMode: a.speculative_mode_effective,
      prefixHitTokens: a.prefix_hit_tokens,
      suffixPrefillTokens: a.suffix_prefill_tokens,
    });
  }
}
