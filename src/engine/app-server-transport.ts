import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type RpcId = string | number;
export type RpcNotification = { method: string; params?: unknown };
export type RpcServerRequest = RpcNotification & { id: RpcId };
type RpcError = { code: number; message: string; data?: unknown };
export class AppServerError extends Error {
  constructor(
    readonly code: number | string,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "AppServerError";
  }
}
export interface TransportOptions {
  executable: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  onNotification: (message: RpcNotification) => void;
  onRequest: (message: RpcServerRequest) => void;
  onClose: (error: AppServerError) => void;
  requestTimeoutMs?: number;
  maxLineBytes?: number;
  /** Release only host-created provider resources owned by this Core process. */
  cleanup?: () => Promise<void>;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const validId = (v: unknown): v is RpcId =>
  typeof v === "string" || (typeof v === "number" && Number.isSafeInteger(v));

/** Owns exactly one stdio App Server. No renderer-supplied executable or RPC. */
export class AppServerTransport {
  private child: ChildProcessWithoutNullStreams;
  private decoder = new StringDecoder("utf8");
  private buffer = "";
  private serial = 0;
  private pending = new Map<
    RpcId,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  private inbound = new Set<RpcId>();
  private dead: AppServerError | null = null;
  private closing: Promise<void> | null = null;
  private exited: Promise<void>;
  private stdioClosed = false;
  private stderrTail = "";
  private resourceCleanup?: Promise<void>;
  constructor(private options: TransportOptions) {
    this.child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "pipe",
      windowsHide: true,
      detached: process.platform !== "win32",
      shell: false,
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", (code, signal) => {
        this.stdioClosed = true;
        if (!this.dead)
          this.fail(
            new AppServerError(
              "PROCESS_EXIT",
              `App Server exited (${signal ?? code ?? "unknown"})`,
            ),
          );
        resolve();
      });
    });
    this.child.once("error", (error) =>
      this.fail(new AppServerError("PROCESS_ERROR", error.message)),
    );
    this.child.stdin.on("error", (error) =>
      this.fail(new AppServerError("PIPE_ERROR", error.message)),
    );
    this.child.stdout.on("data", (data: Buffer) => {
      if (this.dead) return;
      try {
        this.buffer += this.decoder.write(data);
        const limit = options.maxLineBytes ?? 16 * 1024 * 1024;
        for (
          let end = this.buffer.indexOf("\n");
          end >= 0;
          end = this.buffer.indexOf("\n")
        ) {
          const line = this.buffer.slice(0, end);
          this.buffer = this.buffer.slice(end + 1);
          if (Buffer.byteLength(line) > limit)
            throw new Error("JSONL frame exceeds limit");
          if (line.trim()) this.receive(JSON.parse(line));
        }
        if (Buffer.byteLength(this.buffer) > limit)
          throw new Error("Unterminated JSONL frame exceeds limit");
      } catch (error) {
        this.fail(
          new AppServerError(
            "PROTOCOL_ERROR",
            error instanceof Error ? error.message : "Invalid JSONL",
          ),
        );
        void this.close();
      }
    });
    this.child.stdout.on("end", () => {
      this.buffer += this.decoder.end();
      if (!this.dead && this.buffer.trim())
        this.fail(
          new AppServerError(
            "TRUNCATED_FRAME",
            "App Server closed with an incomplete JSONL frame",
          ),
        );
    });
    // Never expose raw stderr in renderer errors: upstream logs may include user data.
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-8192);
    });
  }
  get pid() {
    return this.child.pid;
  }
  get activeRequests() {
    return this.pending.size;
  }
  get diagnostics() {
    return {
      pid: this.pid,
      activeRequests: this.pending.size,
      closed: !!this.dead,
    };
  }
  private receive(message: unknown) {
    if (!object(message))
      throw new Error("App Server message must be an object");
    if (typeof message.method === "string") {
      if ("result" in message || "error" in message)
        throw new Error("Ambiguous RPC message");
      if ("id" in message) {
        if (!validId(message.id) || this.inbound.has(message.id))
          throw new Error("Invalid or duplicate server request ID");
        this.inbound.add(message.id);
        this.options.onRequest(message as RpcServerRequest);
      } else this.options.onNotification(message as RpcNotification);
      return;
    }
    if (!validId(message.id) || "result" in message === "error" in message)
      throw new Error(
        "RPC response requires one result or error and an exact ID",
      );
    if (
      "error" in message &&
      (!object(message.error) ||
        !Number.isSafeInteger(message.error.code) ||
        typeof message.error.message !== "string")
    )
      throw new Error("Invalid RPC error envelope");
    const pending = this.pending.get(message.id);
    // A timed-out request can have a late reply; never attach it to another ID.
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if ("error" in message) {
      const error = message.error as RpcError;
      pending.reject(new AppServerError(error.code, error.message, error.data));
    } else pending.resolve(message.result);
  }
  private send(message: unknown) {
    if (this.dead) throw this.dead;
    const line = JSON.stringify(message) + "\n";
    if (
      Buffer.byteLength(line) > (this.options.maxLineBytes ?? 16 * 1024 * 1024)
    )
      throw new AppServerError(
        "FRAME_TOO_LARGE",
        "RPC request exceeds transport limit",
      );
    if (this.child.stdin.writableLength > 32 * 1024 * 1024)
      throw new AppServerError(
        "BACKPRESSURE",
        "App Server is not consuming requests",
      );
    this.child.stdin.write(line);
  }
  request<T>(
    method: string,
    params: unknown,
    timeoutMs = this.options.requestTimeoutMs ?? 60000,
  ): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = `synora-${++this.serial}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppServerError(
            "RPC_TIMEOUT",
            `App Server ${method} acknowledgement timed out`,
            { method, id },
          ),
        );
      }, timeoutMs);
      this.pending.set(id, { resolve: (v) => resolve(v as T), reject, timer });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  notify(method: string, params: unknown = {}) {
    this.send({ method, params });
  }
  respond(id: RpcId, response: { result: unknown } | { error: RpcError }) {
    if (!this.inbound.has(id))
      throw new AppServerError(
        "STALE_REQUEST",
        "Unknown or already answered server request",
      );
    this.send({ id, ...response });
    this.inbound.delete(id);
  }
  private fail(error: AppServerError) {
    if (this.dead) return;
    this.dead = error;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(error);
    }
    this.pending.clear();
    this.inbound.clear();
    // Also release resources when Core exits unexpectedly and no caller has
    // yet awaited close(). The original promise remains observable by close.
    void this.releaseResources().catch(() => {});
    this.options.onClose(error);
  }
  private releaseResources(): Promise<void> {
    return (this.resourceCleanup ??= Promise.resolve().then(() =>
      this.options.cleanup?.(),
    ));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.shutdown().finally(() => this.releaseResources());
    return this.closing;
  }
  private async shutdown() {
    this.fail(
      new AppServerError(
        "TRANSPORT_CLOSED",
        "Synora closed its App Server connection",
      ),
    );
    const pid = this.child.pid;
    if (
      !pid ||
      (process.platform === "win32" &&
        (this.child.exitCode !== null || this.child.signalCode !== null))
    ) {
      await this.exited;
      return;
    }
    this.child.stdin.end();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const graceful = await Promise.race([
        this.exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      if (graceful) return;
    } finally {
      clearTimeout(timer);
    }
    // Only the process tree spawned by this object. No kernel/service termination.
    if (process.platform === "win32") {
      await new Promise<void>((resolve, reject) => {
        const kill = spawn("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
          windowsHide: true,
        });
        kill.once("error", reject);
        kill.once("close", () => resolve());
      });
    } else {
      try {
        process.kill(-pid, "SIGTERM");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      timer = setTimeout(() => {
        // The leader can exit while descendants still own its stdout/stderr.
        // Escalate for the original process group until the pipes really close,
        // not only while the already-exited leader is alive.
        if (!this.stdioClosed) {
          try {
            process.kill(-pid, "SIGKILL");
          } catch {
            /* already exited */
          }
        }
      }, 2000);
    }
    try {
      await this.exited;
    } finally {
      clearTimeout(timer);
    }
  }
}
