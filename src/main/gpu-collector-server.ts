import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { gpuTelemetrySchema, type GpuTelemetry } from "../shared/gpu-telemetry";
import { sampleGpus } from "./gpu-sampler";

/** Fixed read-only surface. No provider credentials, process list, commands or paths from callers. */
export function gpuCollectorHandler(token: string, sample: () => Promise<GpuTelemetry> = sampleGpus) {
  if (!/^[a-f0-9]{64}$/.test(token)) throw Error("A dedicated 256-bit telemetry token is required");
  let pending: Promise<GpuTelemetry> | undefined;
  let cached: { at: number; sample: GpuTelemetry } | undefined;
  const read = () => {
    if (cached && Date.now() - cached.at < 2000) return Promise.resolve(cached.sample);
    if (!pending) {
      pending = sample().then(gpuTelemetrySchema.parse).then(value => {
        cached = { at: Date.now(), sample: value }; return value;
      }).finally(() => { pending = undefined; });
    }
    return pending;
  };
  return async (req: IncomingMessage, res: ServerResponse) => {
    res.setHeader("Cache-Control", "no-store"); res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Type", "application/json");
    const reply = (code: number, value: unknown) => { if (!res.destroyed) { res.writeHead(code); res.end(JSON.stringify(value)); } };
    const expected = Buffer.from(`Bearer ${token}`), supplied = Buffer.from(req.headers.authorization ?? "");
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return reply(401, { error: "UNAUTHORIZED" });
    if (req.headers.origin) return reply(403, { error: "FORBIDDEN" });
    if (req.method !== "GET") return reply(405, { error: "READ_ONLY" });
    if (req.headers["content-length"] || req.headers["transfer-encoding"]) return reply(403, { error: "FORBIDDEN" });
    if (req.url !== "/v1/gpus") return reply(404, { error: "NOT_FOUND" });
    // A timed-out reader remains single-flight until it settles: no accumulating
    // GPU queries or stale successful fallback while a driver/filesystem is stuck.
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([read(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("sample deadline")), 3000);
      })]);
      reply(200, value);
    } catch { reply(503, { error: "GPU_SAMPLE_UNAVAILABLE" }); }
    finally { clearTimeout(timer); }
  };
}
