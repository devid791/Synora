import { request } from "node:https";
import { readFile, lstat } from "node:fs/promises";
import { z } from "zod";
import type { BackendProbe } from "../shared/backend-status";
import { gpuTelemetrySchema, type GpuTelemetry } from "../shared/gpu-telemetry";

const connection = z.object({
  providerEndpoint: z.string().url().max(2048),
  endpoint: z.string().url().max(2048).refine(v => { const u = new URL(v); return u.protocol === "https:" &&
    !u.username && !u.password && !u.search && !u.hash && u.pathname === "/v1/gpus"; }),
  certificate: z.string().min(100).max(8192),
  token: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
const registrySchema = z.array(connection).max(32);
type Connection = z.infer<typeof connection>;
const notConfigured = (): BackendProbe<GpuTelemetry> => ({
  state: "unavailable", code: "GPU_NOT_CONFIGURED",
  message: "No GPU collector is configured for this Axiom provider on this client. Configure a trusted collector connection; inference is independent.",
  observedAt: Date.now(), durationMs: 0, httpStatus: null,
});

/** Host-owned private registry; no token/certificate readback to renderer or remote content.
 * Dedicated telemetry token is bound to exact configured HTTPS URL and CA. */
export class GpuCollectorClient {
  private pending = new Set<AbortController>();
  private closed = false;
  private epoch = 0;
  constructor(private file: string) {}
  async read(providerEndpoint: string): Promise<BackendProbe<GpuTelemetry> | undefined> {
    const epoch = this.epoch;
    if (this.closed) return;
    let settings: Connection | undefined;
    try {
      const stat = await lstat(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 ||
        (process.platform !== "win32" && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))) throw Error();
      const entries = registrySchema.parse(JSON.parse(await readFile(this.file, "utf8")));
      const matches = entries.filter(e => e.providerEndpoint.replace(/\/$/, "") === providerEndpoint.replace(/\/$/, ""));
      if (matches.length > 1) throw Error();
      settings = matches[0];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return notConfigured();
      return { state: "unavailable", code: "GPU_CONFIG", message: "GPU collector configuration is unavailable or invalid.",
        observedAt: Date.now(), durationMs: 0, httpStatus: null };
    }
    if (this.closed || epoch !== this.epoch) return;
    if (!settings) return notConfigured();
    const start = Date.now(); let httpStatus: number | null = null;
    const controller = new AbortController(); this.pending.add(controller);
    if (this.closed) controller.abort();
    const timer = setTimeout(() => controller.abort(), 4000);
    try {
      const data = await new Promise<GpuTelemetry>((resolve, reject) => {
        const req = request(settings!.endpoint, { method: "GET", ca: settings!.certificate, rejectUnauthorized: true,
          signal: controller.signal, agent: false, headers: { Authorization: `Bearer ${settings!.token}` } }, res => {
          httpStatus = res.statusCode ?? null;
          if (res.statusCode !== 200) { res.destroy(); req.destroy(); reject(Error("HTTP")); return; }
          const chunks: Buffer[] = []; let bytes = 0;
          res.on("data", (chunk: Buffer) => { bytes += chunk.length;
            if (bytes > 256 * 1024) { req.destroy(); reject(Error("size")); } else chunks.push(chunk); });
          res.on("error", reject); res.on("aborted", () => reject(Error("aborted")));
          res.on("end", () => { try { resolve(gpuTelemetrySchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")))); } catch { reject(Error("schema")); } });
        });
        req.on("error", reject); req.end();
      });
      // This endpoint's timestamp is an actual sensor sample, not request retrieval.
      if (controller.signal.aborted || epoch !== this.epoch || this.closed || data.sampledAt > Date.now() + 5000 || Date.now() - data.sampledAt > 15000) throw Error("stale");
      return { state: "available", data, observedAt: Date.now(), durationMs: Date.now() - start, httpStatus };
    } catch { return { state: "unavailable", code: "GPU_UNAVAILABLE",
      message: "GPU telemetry is unavailable, stale or failed TLS/authentication validation. Inference state is independent.",
      observedAt: Date.now(), durationMs: Date.now() - start, httpStatus }; }
    finally { clearTimeout(timer); this.pending.delete(controller); }
  }
  reset() { this.epoch++; for (const controller of this.pending) controller.abort(); }
  dispose() { this.closed = true; this.reset(); }
}
