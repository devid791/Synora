import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  AxiomTelemetryObserver,
  requestIdentity,
  storedAxiomMetrics,
} from "../src/engine/axiom-telemetry";
import type {
  AxiomRequestMetrics,
  EventEnvelope,
} from "../src/shared/contracts";
import { Store } from "../src/main/store";
import { emptyEngine, reduceEngine } from "../src/renderer/engine-state";

const expected = {
  session_id: "session",
  thread_id: "thread",
  turn_id: "turn",
  model: "model",
};
const response = () => ({
  type: "response.completed",
  response: {
    ...expected,
    id: "response-1",
    status: "completed",
    usage: { input_tokens: 100, output_tokens: 30, total_tokens: 130 },
    axiom: {
      session_id: "session",
      reasoning_effort: "medium",
      thinking_tokens: 24,
      visible_output_tokens: 6,
      thinking_budget: 4096,
      prefill_seconds: 1,
      decode_seconds: 0.5,
      ttft_seconds: 1.01,
      decode_tokens_per_second: 60,
      visible_tokens_per_second: 12,
      decode_path: "scalar_sampling",
      speculative_mode_effective: "target",
      prefix_hit_tokens: 80,
      suffix_prefill_tokens: 20,
    },
  },
});
const frame = (value: unknown) =>
  Buffer.from(
    `event: response.completed\r\ndata: ${JSON.stringify(value)}\r\n\r\n`,
  );
function observe(value: unknown, size = 3) {
  const results: AxiomRequestMetrics[] = [];
  const parser = new AxiomTelemetryObserver(expected, (r) => results.push(r));
  const input = Buffer.concat([
    Buffer.from(": keepalive 🛰️\n\n"),
    frame(value),
    frame(value),
  ]);
  for (let i = 0; i < input.length; i += size)
    parser.write(input.subarray(i, i + size));
  return results;
}
test("Axiom telemetry preserves exact identity, actual thinking and generated-token accounting across SSE chunks", () => {
  assert.deepEqual(
    requestIdentity(Buffer.from(JSON.stringify({ client_metadata: expected }))),
    { session_id: "session", thread_id: "thread", turn_id: "turn" },
  );
  assert.equal(requestIdentity(Buffer.from("{}")), undefined);
  for (const size of [1, 3, 64, 65536]) {
    const results = observe(response(), size);
    assert.equal(
      results.length,
      1,
      "A repeated completion cannot double count tokens",
    );
    const m = storedAxiomMetrics.parse(results[0]);
    assert.equal(m.thinkingTokens, 24);
    assert.equal(m.visibleTokens, 6);
    assert.equal(m.turnId, "turn");
    assert.equal(m.source, "axiom-response");
    assert.equal(m.outputTokens, 30);
    assert.equal(m.prefixHitTokens, 80);
    assert.equal(m.decodeTokensPerSecond, 60);
  }
});
test("Missing, oversized, malformed, impossible and cross-session telemetry never become zero or another turn's data", () => {
  for (const mutate of [
    (v: any) => {
      v.response.turn_id = "other";
    },
    (v: any) => {
      v.response.session_id = "other";
    },
    (v: any) => {
      v.response.axiom.session_id = "other";
    },
    (v: any) => {
      v.response.model = "other";
    },
    (v: any) => {
      v.response.usage.output_tokens = 29;
    },
    (v: any) => {
      v.response.axiom.thinking_tokens = -1;
    },
    (v: any) => {
      delete v.response.axiom.thinking_tokens;
    },
    (v: any) => {
      v.response.axiom.decode_seconds = Infinity;
    },
    (v: any) => {
      v.response.status = "failed";
    },
  ]) {
    const v = response();
    mutate(v);
    assert.deepEqual(observe(v), []);
  }
  const metrics: AxiomRequestMetrics[] = [];
  const parser = new AxiomTelemetryObserver(
    expected,
    (m) => metrics.push(m),
    512,
  );
  parser.write(Buffer.from(`data: ${"x".repeat(600)}`));
  parser.write(frame(response()));
  assert.equal(metrics.length, 0);
  const broken = new AxiomTelemetryObserver(expected, (m) => metrics.push(m));
  broken.write(Buffer.from([0xc3, 0x28]));
  broken.write(frame(response()));
  assert.equal(metrics.length, 0);
});
test("Backend measurement reducer and SQLite history preserve values across restart without altering Core usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "synora-metrics-test-"));
  const path = join(dir, "state.sqlite");
  let store = new Store(path);
  try {
    const c = store.conversation(null),
      m = observe(response())[0];
    store.update((s) => {
      s.conversations.find((v) => v.id === c.id)!.backendRequests = [m];
    });
    store.close();
    store = new Store(path);
    assert.deepEqual(store.read().conversations[0].backendRequests, [m]);
    const envelope: EventEnvelope = {
      simulated: false,
      sequence: 1,
      at: Date.now(),
      event: { kind: "backend-metrics", metrics: m },
    };
    const state = reduceEngine(emptyEngine, envelope);
    assert.deepEqual(state.backendRequests, [m]);
    assert.equal(
      state.tokenUsage,
      undefined,
      "Original Core usage is not silently rewritten",
    );
    assert.deepEqual(
      reduceEngine(state, { ...envelope, sequence: 2 }).backendRequests,
      [m],
    );
    assert.throws(() =>
      store.update((s) => {
        s.conversations[0].backendRequests![0].thinkingTokens = -1;
      }),
    );
    assert.equal(
      store.read().conversations[0].backendRequests![0].thinkingTokens,
      24,
    );
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
