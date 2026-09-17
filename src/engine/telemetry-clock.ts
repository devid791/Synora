/** HTTP Date is in the telemetry server's clock domain, unlike the client's
 * wall clock. Keep an upper age bound (Date's 1s precision, cache Age and the
 * complete request duration). Never refresh a frozen response just because
 * it was fetched again. Raw sample timestamps remain untouched.
 * The serving proxy and hardware producer must share a clock domain. */
export class TelemetryClock {
  private anchor?: { serverTime: number; monotonicTime: number };

  observe(headers: Headers, durationMs: number, monotonicTime: number): number | undefined {
    const date = headers.get("date");
    const age = headers.get("age");
    const serverTime = date === null ? NaN : Date.parse(date);
    const ageSeconds = age === null ? 0 : /^\d+$/.test(age) ? Number(age) : NaN;
    const candidate = serverTime + 999 + ageSeconds * 1000 + durationMs;
    if (!Number.isFinite(candidate) || candidate < 0 || candidate > Number.MAX_SAFE_INTEGER ||
        !Number.isFinite(durationMs) || durationMs < 0) return undefined;
    const previous = this.anchor;
    const current = previous
      ? Math.max(candidate, previous.serverTime + Math.max(0, monotonicTime - previous.monotonicTime))
      : candidate;
    this.anchor = { serverTime: current, monotonicTime };
    return current;
  }
}
