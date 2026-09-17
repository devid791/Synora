import type { z } from "zod";
import { axiomEndpoint } from "./axiom-process";
import { bearerHeaders } from "./axiom-auth";
import { createHash } from "node:crypto";
import { hardwareSchema, hardwareGpuProbe } from "../shared/hardware";
import { TelemetryClock } from "./telemetry-clock";
import {
  runtimeStatusSchema,
  resourceStatusSchema,
  kvStatusSchema,
  type BackendProbe,
  type BackendStatus,
} from "../shared/backend-status";

/** Read-only, independent of the generation transport/queue. No health inference. */
export class AxiomStatus {
  private current?: {
    endpoint: string;
    authIdentity: string;
    controller: AbortController;
    promise: Promise<BackendStatus>;
    finishedAt?: number;
    hardwareClock: TelemetryClock;
  };
  private disposed = false;
  constructor(private options: { timeoutMs?: number; cacheMs?: number } = {}) {}
  read(endpoint: string, bearerToken?: string): Promise<BackendStatus> {
    if (this.disposed)
      return Promise.reject(new Error("Backend monitor is closed"));
    endpoint = axiomEndpoint(endpoint);
    const headers = bearerHeaders(endpoint, bearerToken);
    const authIdentity = createHash("sha256")
      .update(bearerToken ?? "")
      .digest("hex");
    const old = this.current;
    if (
      old?.endpoint === endpoint &&
      old.authIdentity === authIdentity &&
      (old.finishedAt === undefined ||
        performance.now() - old.finishedAt < (this.options.cacheMs ?? 2000))
    )
      return old.promise;
    old?.controller.abort();
    const hardwareClock = old?.endpoint === endpoint && old.authIdentity === authIdentity
      ? old.hardwareClock : new TelemetryClock();
    const controller = new AbortController();
    const root = endpoint.slice(0, -"/codex/v1".length);
    const promise = Promise.all([
      this.probe(
        `${root}/ops/runtime`,
        runtimeStatusSchema,
        controller.signal,
        headers,
      ),
      this.probe(
        `${root}/ops/usage`,
        resourceStatusSchema,
        controller.signal,
        headers,
      ),
      this.probe(`${root}/ops/kv`, kvStatusSchema, controller.signal, headers),
      this.probe(`${root}/ops/hardware`, hardwareSchema, controller.signal, headers, hardwareClock),
    ]).then(
      ([runtime, resources, kv, hardware]): BackendStatus => ({
        mode: "live",
        endpoint,
        runtime,
        resources,
        kv,
        hardware,
        gpu: hardwareGpuProbe(hardware),
      }),
    );
    const entry = {
      endpoint,
      authIdentity,
      controller,
      promise,
      hardwareClock,
      finishedAt: undefined as number | undefined,
    };
    this.current = entry;
    void promise.then(() => {
      entry.finishedAt = performance.now();
    });
    return promise;
  }
  reset() {
    this.current?.controller.abort();
    this.current = undefined;
  }
  dispose() {
    this.disposed = true;
    this.reset();
  }
  private async probe<T>(
    url: string,
    schema: z.ZodType<T>,
    parent: AbortSignal,
    headers: Record<string, string>,
    sampleClock?: TelemetryClock,
  ): Promise<BackendProbe<T>> {
    const start = performance.now();
    let httpStatus: number | null = null;
    const controller = new AbortController();
    const cancel = () => controller.abort();
    parent.addEventListener("abort", cancel, { once: true });
    if (parent.aborted) cancel();
    const timer = setTimeout(cancel, this.options.timeoutMs ?? 5000);
    let code = "STATUS_UNAVAILABLE";
    try {
      const response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers,
        cache: "no-store",
      });
      httpStatus = response.status;
      if (!response.ok) {
        await response.body?.cancel();
        code = "STATUS_HTTP";
        throw new Error(
          `Status endpoint returned HTTP ${response.status}; inference availability is not determined by this error.`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error("Status endpoint returned no body");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > 512 * 1024) {
            code = "STATUS_TOO_LARGE";
            throw new Error(
              "Status document exceeds the supported 512 KiB size",
            );
          }
          chunks.push(value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      code = "STATUS_SCHEMA";
      const data = schema.parse(
        JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(
            Buffer.concat(chunks),
          ),
        ),
      );
      const finished = performance.now();
      const durationMs = finished - start;
      const serverTimeAtObservation = sampleClock?.observe(response.headers, durationMs, finished);
      return {
        state: "available",
        data,
        observedAt: Date.now(),
        durationMs,
        ...(serverTimeAtObservation === undefined ? {} : { serverTimeAtObservation }),
        httpStatus,
      };
    } catch (error) {
      return {
        state: "unavailable",
        observedAt: Date.now(),
        durationMs: performance.now() - start,
        httpStatus,
        code: controller.signal.aborted ? "STATUS_TIMEOUT_OR_CANCELLED" : code,
        message: controller.signal.aborted
          ? "Status probe timed out or was cancelled; model state is unknown."
          : code === "STATUS_SCHEMA"
            ? "Status document did not match the supported Axiom schema; no measurements were inferred."
            : code === "STATUS_UNAVAILABLE"
              ? "Cannot reach the status endpoint; model state is unknown."
              : error instanceof Error
                ? error.message
                : "Status request failed",
      };
    } finally {
      clearTimeout(timer);
      parent.removeEventListener("abort", cancel);
    }
  }
}
