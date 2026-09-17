import test from "node:test";
import assert from "node:assert/strict";
import { TelemetryClock } from "../src/engine/telemetry-clock";
import { sampleClockNow } from "../src/shared/backend-status";
import { sampleStale } from "../src/shared/resource-telemetry";

const at = 1_800_000_000_000;
test("Remote clock includes Date precision, cache Age and transport duration", () => {
  const clock = new TelemetryClock();
  const headers = new Headers({date: new Date(at).toUTCString(), age: "20"});
  const observed = clock.observe(headers, 50, 100)!;
  assert.equal(observed, at + 21_049);
  assert.equal(sampleStale(at, observed), true, "Old cached samples stay stale");
});
test("Fetching an unchanged Date and sample cannot keep a frozen collector fresh", () => {
  const clock = new TelemetryClock();
  const headers = new Headers({date: new Date(at).toUTCString()});
  assert.equal(sampleStale(at, clock.observe(headers, 10, 0)!), false);
  assert.equal(sampleStale(at, clock.observe(headers, 10, 8000)!), true);
  assert.equal(sampleStale(at, clock.observe(headers, 10, 16000)!), true);
});
test("Missing or invalid clock headers retain strict fallback, never synthesize current samples", () => {
  for (const headers of [new Headers(), new Headers({date: "invalid"}),
    new Headers({date: new Date(at).toUTCString(), age: "-1"}),
    new Headers({date: new Date(at).toUTCString(), age: "9".repeat(30)})]) {
    assert.equal(new TelemetryClock().observe(headers, 10, 0), undefined);
  }
  assert.equal(sampleClockNow({observedAt: at}, at + 30_000), at + 30_000);
  assert.equal(sampleStale(at, NaN), true);
});
test("A clock-corrected observation still expires in background and rejects local clock rollback", () => {
  for (const skew of [-30_000, 30_000, -43_200_000, 43_200_000]) {
    const probe = { observedAt: at + skew, serverTimeAtObservation: at + 999 };
    assert.equal(sampleStale(at, sampleClockNow(probe, probe.observedAt)), false);
    assert.equal(sampleStale(at, sampleClockNow(probe, probe.observedAt + 8000)), true);
    assert.equal(sampleStale(at, sampleClockNow(probe, probe.observedAt - 5000)), true);
    assert.equal(sampleStale(at + 5000, sampleClockNow(probe, probe.observedAt)), true);
  }
});
