import test from "node:test";
import assert from "node:assert/strict";
import { totalmem } from "node:os";
import {
  sampleHostMemory,
  type HostMemorySamplerDependencies,
} from "../src/main/local-resource-metrics";
import type { HostMemorySample } from "../src/shared/local-resource-metrics";

const observedAt = 1_789_056_000_000;
const GiB = 1024 ** 3;
const dependencies: Readonly<HostMemorySamplerDependencies> = Object.freeze({
  now: () => observedAt,
  totalmem: () => 16 * GiB,
  freemem: () => 5 * GiB,
});

function assertAvailable(
  sample: HostMemorySample,
): asserts sample is Extract<HostMemorySample, { state: "available" }> {
  assert.ok(sample.state === "available");
  assert.equal(sample.source, "node:os");
  assert.ok(typeof sample.observedAt === "number");
  assert.ok(Number.isSafeInteger(sample.observedAt));
  assert.ok(sample.observedAt >= 0);
  for (const value of [
    sample.totalBytes,
    sample.freeBytes,
    sample.nonFreeBytes,
  ]) {
    assert.ok(typeof value === "number");
    assert.ok(Number.isFinite(value));
    assert.ok(Number.isSafeInteger(value));
    assert.ok(value >= 0);
  }
  assert.equal(sample.totalBytes, sample.freeBytes + sample.nonFreeBytes);
}

function assertUnavailable(
  sample: HostMemorySample,
  reason: string,
  timestamp: number | null = observedAt,
) {
  assert.deepEqual(sample, {
    state: "unavailable",
    source: "node:os",
    observedAt: timestamp,
    reason,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(sample)), sample);
}

test("Host RAM reports byte counts and provenance, separately from process RSS", () => {
  const sample = sampleHostMemory(dependencies);
  assertAvailable(sample);
  assert.deepEqual(sample, {
    state: "available",
    source: "node:os",
    observedAt,
    totalBytes: 16 * GiB,
    freeBytes: 5 * GiB,
    nonFreeBytes: 11 * GiB,
  });
  assert.equal("rssBytes" in sample, false);
  assert.equal("pressure" in sample, false);
  assert.deepEqual(JSON.parse(JSON.stringify(sample)), sample);
});

test("Genuine zero and safe-integer boundary readings preserve conservation", () => {
  for (const [totalBytes, freeBytes] of [
    [0, 0],
    [16 * GiB, 0],
    [16 * GiB, 16 * GiB],
    [Number.MAX_SAFE_INTEGER, 0],
    [Number.MAX_SAFE_INTEGER, 1],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER - 1],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
  ]) {
    const sample = sampleHostMemory({
      now: () => 0,
      totalmem: () => totalBytes,
      freemem: () => freeBytes,
    });
    assertAvailable(sample);
    assert.equal(sample.observedAt, 0);
    assert.equal(sample.totalBytes, totalBytes);
    assert.equal(sample.freeBytes, freeBytes);
    assert.equal(sample.nonFreeBytes, totalBytes - freeBytes);
  }
});

const invalidValues: unknown[] = [
  NaN,
  Infinity,
  -Infinity,
  -1,
  0.5,
  Number.MAX_SAFE_INTEGER + 1,
  Number.MAX_VALUE,
  "1024",
  null,
  undefined,
  true,
  1024n,
  {},
  [],
];

for (const field of ["totalmem", "freemem"] as const) {
  test(`Invalid ${field} readings are unavailable, without coercion or partial bytes`, () => {
    for (const value of invalidValues) {
      assertUnavailable(
        sampleHostMemory({ ...dependencies, [field]: () => value as number }),
        "invalid-sample",
      );
    }
  });
}

test("Free RAM greater than total is unavailable, never clamped to zero", () => {
  for (const [totalBytes, freeBytes] of [
    [0, 1],
    [1024, 1025],
  ]) {
    assertUnavailable(
      sampleHostMemory({
        ...dependencies,
        totalmem: () => totalBytes,
        freemem: () => freeBytes,
      }),
      "invalid-sample",
    );
  }
});

test("An invalid clock returns unavailable with no invented timestamp or OS reads", () => {
  for (const value of invalidValues) {
    let reads = 0;
    assertUnavailable(
      sampleHostMemory({
        now: () => value as number,
        totalmem: () => ++reads,
        freemem: () => ++reads,
      }),
      "invalid-timestamp",
      null,
    );
    assert.equal(reads, 0);
  }
});

for (const field of ["now", "totalmem", "freemem"] as const) {
  test(`A throwing ${field} reader returns unavailable without retries or error details`, () => {
    const calls: string[] = [];
    const read =
      (name: keyof HostMemorySamplerDependencies, value: number) => () => {
        calls.push(name);
        if (field === name) throw new Error("Private underlying error");
        return value;
      };
    assertUnavailable(
      sampleHostMemory({
        now: read("now", observedAt),
        totalmem: read("totalmem", 16 * GiB),
        freemem: read("freemem", 5 * GiB),
      }),
      "read-failed",
      field === "now" ? null : observedAt,
    );
    const order = ["now", "totalmem", "freemem"];
    assert.deepEqual(calls, order.slice(0, order.indexOf(field) + 1));
  });
}

test("Each call samples synchronously once and retains no earlier result", () => {
  const calls: string[] = [];
  let freeBytes = 5 * GiB;
  let timestamp = observedAt;
  const readers = Object.freeze({
    now() {
      calls.push("now");
      return timestamp;
    },
    totalmem() {
      calls.push("totalmem");
      return 16 * GiB;
    },
    freemem() {
      calls.push("freemem");
      return freeBytes;
    },
  });
  const first = sampleHostMemory(readers);
  assertAvailable(first);
  assert.deepEqual(calls, ["now", "totalmem", "freemem"]);
  freeBytes = NaN;
  timestamp++;
  assertUnavailable(sampleHostMemory(readers), "invalid-sample", timestamp);
  freeBytes = 6 * GiB;
  timestamp++;
  const next = sampleHostMemory(readers);
  assertAvailable(next);
  assert.notEqual(first, next);
  assert.equal(first.freeBytes, 5 * GiB);
  assert.equal(first.observedAt, observedAt);
  assert.equal(next.freeBytes, 6 * GiB);
  assert.equal(next.observedAt, timestamp);
  assert.deepEqual(calls, Array(3).fill(["now", "totalmem", "freemem"]).flat());
});

test("Default sampler reads actual Node OS RAM with valid provenance and conservation", () => {
  const before = Date.now();
  const sample = sampleHostMemory();
  const after = Date.now();
  assertAvailable(sample);
  assert.ok(sample.observedAt >= before && sample.observedAt <= after);
  assert.ok(sample.totalBytes > 0);
  assert.equal(sample.totalBytes, totalmem());
  // Free RAM changes while this test runs; do not compare separate OS reads.
  assert.ok(sample.freeBytes <= sample.totalBytes);
});
