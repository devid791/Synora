import test from "node:test";
import assert from "node:assert/strict";
import { appendMemoryPoint, utilization, sampleStale, requestRates } from "../src/shared/resource-telemetry";
import type { AxiomRequestMetrics } from "../src/shared/contracts";
test("Utilization preserves real zero, refuses unknown capacity, and clamps only visual overflow", () => {
  for (const invalid of [null, undefined, NaN, Infinity, -1, "1"]) assert.equal(utilization(invalid, 100), null);
  for (const invalid of [0, null, -1, Infinity]) assert.equal(utilization(1, invalid), null);
  assert.deepEqual(utilization(0, 100), { used: 0, total: 100, percent: 0, fill: 0 });
  assert.deepEqual(utilization(110, 100), { used: 110, total: 100, percent: 110.00000000000001, fill: 100 });
});
test("Timestamps expire; cached and out-of-order reads cannot manufacture history", () => {
  assert.equal(sampleStale(1000, 8000), false); assert.equal(sampleStale(1000, 8001), true);
  assert.equal(sampleStale(10000, 1), true); assert.equal(sampleStale(null, 1), true);
  const first = appendMemoryPoint([], { at: 1000, rssBytes: 8, totalBytes: 16 }, 1000);
  assert.equal(appendMemoryPoint(first, { at: 1000, rssBytes: 9, totalBytes: 16 }, 1100).length, 1);
  assert.equal(appendMemoryPoint(first, { at: 500, rssBytes: 9, totalBytes: 16 }, 1100).length, 1);
  assert.equal(appendMemoryPoint(first, { at: 10, rssBytes: 9, totalBytes: 16 }, 200000).length, 0);
});
test("Local history is bounded in time and count, even with a high-frequency caller", () => {
  let points: ReturnType<typeof appendMemoryPoint> = [];
  for (let i = 0; i < 1000; i++) points = appendMemoryPoint(points, { at: i, rssBytes: i, totalBytes: 1024 }, i);
  assert.equal(points.length, 61);
  points = appendMemoryPoint(points, { at: 200000, rssBytes: 4, totalBytes: 16 }, 200000);
  assert.equal(points.length, 1);
});
test("Request charts use matching thread and unique response IDs; suffix tokens exclude cache hits", () => {
  const request = { responseId: "a", threadId: "thread", observedAt: 100,
    suffixPrefillTokens: 100, inputTokens: 5100, prefillSeconds: 0.5, decodeTokensPerSecond: 409 } as AxiomRequestMetrics;
  const rates = requestRates([request, request, { ...request, responseId: "other", threadId: "other" }], "thread");
  assert.deepEqual(rates, [{ id: "a", at: 100, decode: 409, prefill: 200 }]);
  assert.deepEqual(requestRates([request], null), []);
  assert.equal(requestRates([{ ...request, prefillSeconds: 0 }], "thread")[0].prefill, null);
  assert.equal(requestRates([{ ...request, decodeTokensPerSecond: NaN }], "thread")[0].decode, null);
  assert.equal(requestRates(Array.from({ length: 30 }, (_, i) => ({ ...request, responseId: String(i), observedAt: i })), "thread").length, 24);
});
