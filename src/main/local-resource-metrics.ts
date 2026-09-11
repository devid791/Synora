import { freemem, totalmem } from "node:os";
import type { HostMemorySample } from "../shared/local-resource-metrics";

export interface HostMemorySamplerDependencies {
  now(): number;
  totalmem(): number;
  freemem(): number;
}

function safeNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function unavailable(
  observedAt: number | null,
  reason: string,
): HostMemorySample {
  return {
    state: "unavailable",
    source: "node:os",
    observedAt,
    reason,
  };
}

/**
 * One read-only synchronous sample: each clock/OS reader is called at most once.
 * No polling, retained state or process sampling; LocalMetrics.rssBytes remains
 * a separate process-only metric. The two OS reads are not an atomic snapshot.
 */
export function sampleHostMemory(
  dependencies: Readonly<HostMemorySamplerDependencies> = {
    now: Date.now,
    totalmem,
    freemem,
  },
): HostMemorySample {
  let observedAt: number | null = null;
  try {
    const timestamp = dependencies.now();
    if (!safeNonnegativeInteger(timestamp))
      return unavailable(null, "invalid-timestamp");
    observedAt = timestamp;

    const totalBytes = dependencies.totalmem();
    const freeBytes = dependencies.freemem();
    if (
      !safeNonnegativeInteger(totalBytes) ||
      !safeNonnegativeInteger(freeBytes) ||
      freeBytes > totalBytes
    )
      return unavailable(observedAt, "invalid-sample");

    const nonFreeBytes = totalBytes - freeBytes;
    if (
      !safeNonnegativeInteger(nonFreeBytes) ||
      totalBytes !== freeBytes + nonFreeBytes
    )
      return unavailable(observedAt, "invalid-sample");

    return {
      state: "available",
      source: "node:os",
      observedAt,
      totalBytes,
      freeBytes,
      nonFreeBytes,
    };
  } catch {
    return unavailable(observedAt, "read-failed");
  }
}
