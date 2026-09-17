import type { AxiomRequestMetrics } from "./contracts";

export const TELEMETRY_STALE_MS = 7000;
export const MEMORY_HISTORY_MS = 120_000;
export const MEMORY_HISTORY_POINTS = 61;
export function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
export function utilization(used: unknown, total: unknown) {
  if (!finiteNonnegative(used) || !finiteNonnegative(total) || total === 0) return null;
  const percent = used / total * 100;
  if (!Number.isFinite(percent)) return null;
  // Keep the original numeric overflow visible; only the physical bar is clipped.
  return { used, total, percent, fill: Math.min(100, percent) };
}
export function sampleStale(at: number | null | undefined, now: number) {
  return !finiteNonnegative(now) || !finiteNonnegative(at) || at > now + 1000 || now - at > TELEMETRY_STALE_MS;
}
export type MemoryPoint = { at: number; rssBytes: number; totalBytes: number };
export function appendMemoryPoint(points: MemoryPoint[], point: MemoryPoint, now: number) {
  const retained = points.filter(p => p.at >= now - MEMORY_HISTORY_MS && p.at <= now + 1000);
  if (!utilization(point.rssBytes, point.totalBytes) || sampleStale(point.at, now)) return retained;
  // Repeated cached reads and out-of-order replies must not manufacture samples.
  if (retained.length && point.at <= retained[retained.length - 1].at) return retained;
  return [...retained, point].slice(-MEMORY_HISTORY_POINTS);
}
export function requestRates(requests: AxiomRequestMetrics[] = [], threadId: string | null) {
  const unique = new Map<string, AxiomRequestMetrics>();
  for (const r of requests) {
    if (threadId && r.threadId === threadId && finiteNonnegative(r.observedAt))
      unique.set(r.responseId, r);
  }
  return [...unique.values()].sort((a, b) => a.observedAt - b.observedAt).slice(-24).map(r => ({
    id: r.responseId, at: r.observedAt,
    decode: finiteNonnegative(r.decodeTokensPerSecond) ? r.decodeTokensPerSecond : null,
    prefill: finiteNonnegative(r.suffixPrefillTokens) && finiteNonnegative(r.prefillSeconds) && r.prefillSeconds > 0
      ? r.suffixPrefillTokens / r.prefillSeconds : null,
  }));
}
