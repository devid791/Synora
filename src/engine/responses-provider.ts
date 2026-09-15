import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
} from "node:http";
import { request as httpsRequest } from "node:https";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import type { Transform } from "node:stream";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import {
  appServerEnvironment,
  type prepareAxiomProcess,
} from "./axiom-process";
import { bearerHeaders } from "./axiom-auth";
import { managedCore, selectedCoreVersion } from "./core-runtime";
import { mcpConfiguration } from "./mcp-config";
import {
  createProcessCatalog,
  processResourceCleanup,
} from "./process-catalog";
import {
  ResponsesToolCodec,
  ResponsesToolError,
  ResponsesToolStream,
} from "./responses-tool-codec";
import { type ModelCapabilities } from "../shared/contracts";

export class ProviderCompatibilityError extends Error {
  constructor(
    readonly code: string,
    readonly path: string,
    readonly reason: string,
  ) {
    super(`${path}: ${reason}`);
  }
}
export interface ResponsesEnvelope {
  tools: ResponsesToolCodec;
  metadata: { path: string; value: unknown }[];
  request(raw: Buffer): Buffer;
}
export interface ResponsesAdapter {
  id: string;
  name: string;
  /** Explicit opt-in only for an operator-configured anonymous endpoint. */
  allowAnonymous?: boolean;
  models(endpoint: string, token?: string): Promise<ModelCapabilities[]>;
  validate(
    models: ModelCapabilities[],
    model: string,
    effort?: string,
  ): ModelCapabilities;
  bridge(options: {
    endpoint: string;
    token: string;
    model: ModelCapabilities;
  }): ReturnType<typeof responsesBridge>;
}
export const PROVIDER_TOKEN_HEADER = "x-synora-provider-capability";
export const PROVIDER_TOKEN_ENV = "SYNORA_PROVIDER_CAPABILITY";
/** Private provider-specific boundary, separate from the untouched Axiom route. */
export async function responsesBridge(options: {
  endpoint: string;
  token: string;
  allowAnonymous?: boolean;
  label: string;
  errorPrefix: string;
  envelope: () => ResponsesEnvelope;
  /** Provider-owned conversion only; never configured by renderer or caller JSON. */
  native?: {
    path:
      | "/messages"
      | "/chat/completions"
      | `/models/${string}:streamGenerateContent?alt=sse`;
    headers:
      | Record<string, string>
      | ((signal: AbortSignal) => Promise<Record<string, string>>);
    authentication?: "replace-bearer";
    stream(envelope: ResponsesEnvelope): Transform;
  };
  deadlineMs?: number;
  onRequest?: (value: {
    original: Buffer;
    wire: Buffer;
    metadata: ResponsesEnvelope["metadata"];
    counts: ResponsesToolCodec["counts"];
  }) => void;
}) {
  const endpoint = options.endpoint,
    authorization =
      options.allowAnonymous && options.token === ""
        ? {}
        : bearerHeaders(endpoint, options.token);
  const fail = (path: string, reason: string): never => {
    throw new ProviderCompatibilityError(
      `${options.errorPrefix}_COMPATIBILITY`,
      path,
      reason,
    );
  };
  const token = randomBytes(32).toString("hex"),
    secret = Buffer.from(token);
  const sockets = new Set<Socket>(),
    active = new Set<AbortController>();
  let authority = "",
    closing: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    const secrets = new Set([options.token]);
    const redact = (value: string) => {
      for (const secret of secrets)
        if (secret) value = value.split(secret).join("[REDACTED]");
      return value;
    };
    const controller = new AbortController();
    active.add(controller);
    const timer = setTimeout(
      () =>
        controller.abort(Error(`${options.label} upstream deadline exceeded`)),
      options.deadlineMs ?? 600000,
    );
    const abort = () => controller.abort(Error("Owned Core connection closed"));
    req.once("aborted", abort);
    res.once("close", abort);
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!req.complete) req.destroy();
      },
      { once: true },
    );
    try {
      const offered = req.headers[PROVIDER_TOKEN_HEADER];
      if (
        closing ||
        req.headers.host !== authority ||
        req.headers.origin ||
        typeof offered !== "string" ||
        Buffer.byteLength(offered) !== secret.length ||
        !timingSafeEqual(Buffer.from(offered), secret)
      ) {
        res.writeHead(403);
        res.end(
          JSON.stringify({
            error: {
              code: "PRIVATE_BRIDGE",
              message: "Owned Synora Core endpoint",
            },
          }),
        );
        return;
      }
      if (req.method !== "POST" || req.url !== "/responses") {
        res.writeHead(404);
        res.end(
          JSON.stringify({
            error: {
              code: `${options.errorPrefix}_ROUTE`,
              message:
                "Unsupported provider operation; Core owns compaction through ordinary Responses",
            },
          }),
        );
        return;
      }
      if (
        req.headers["content-encoding"] &&
        req.headers["content-encoding"] !== "identity"
      )
        fail("$headers.content-encoding", "Unsupported Core encoding");
      const chunks: Buffer[] = [];
      let bytes = 0;
      const bound = 64 * 1024 * 1024;
      if (Number(req.headers["content-length"]) > bound)
        fail("$", "Request exceeds transport memory bound");
      for await (const c of req) {
        bytes += c.length;
        if (bytes > bound) fail("$", "Request exceeds transport memory bound");
        chunks.push(c);
      }
      const original = Buffer.concat(chunks),
        envelope = options.envelope(),
        wire = envelope.request(original);
      options.onRequest?.({
        original,
        wire,
        metadata: envelope.metadata,
        counts: envelope.tools.counts,
      });
      // Never forward Core/OpenAI credentials, cookies, internal headers or URLs.
      const url = new URL(`${endpoint}${options.native?.path ?? "/responses"}`);
      const nativeHeaders =
        typeof options.native?.headers === "function"
          ? await options.native.headers(controller.signal)
          : options.native?.headers;
      for (const [name, value] of Object.entries(nativeHeaders ?? {})) {
        if (/^(authorization|x-api-key|x-goog-api-key)$/i.test(name)) {
          secrets.add(value);
          secrets.add(value.replace(/^Bearer /i, ""));
        }
      }
      controller.signal.throwIfAborted();
      const upstream = await new Promise<IncomingMessage>((resolve, reject) => {
        const call = (url.protocol === "https:" ? httpsRequest : httpRequest)(
          url,
          {
            method: "POST",
            signal: controller.signal,
            headers: {
              ...(options.native?.authentication === "replace-bearer"
                ? {}
                : authorization),
              ...nativeHeaders,
              "content-type": "application/json",
              accept: "text/event-stream",
              "content-length": String(wire.length),
            },
          },
          resolve,
        );
        call.once("error", reject);
        call.end(wire);
      });
      const status = upstream.statusCode ?? 502;
      if (status >= 300 && status < 400) {
        upstream.destroy();
        throw Error(
          `${options.label} redirect rejected; no other endpoint was contacted`,
        );
      }
      if (status !== 200) {
        // Bounded original provider error, with credential redaction; status retained.
        let size = 0;
        const chunks: Buffer[] = [];
        for await (const c of upstream) {
          size += c.length;
          if (size > 65536)
            throw Error(`${options.label} error body exceeds transport bound`);
          chunks.push(c);
        }
        const message = redact(Buffer.concat(chunks).toString("utf8"));
        res.writeHead(status, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            error: {
              code: `${options.errorPrefix}_UPSTREAM`,
              message: `${options.label} HTTP ${status}: ${message}`,
            },
          }),
        );
        return;
      }
      if (
        !/^text\/event-stream(?:;|$)/i.test(
          upstream.headers["content-type"] ?? "",
        )
      ) {
        upstream.destroy();
        throw Error(`${options.label} did not return SSE`);
      }
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
      });
      res.flushHeaders();
      await pipeline(
        [
          upstream,
          ...(options.native ? [options.native.stream(envelope)] : []),
          new ResponsesToolStream(envelope.tools),
          res,
        ],
        {
          signal: controller.signal,
        },
      );
    } catch (e) {
      controller.abort(e);
      if (res.headersSent) res.destroy(e instanceof Error ? e : undefined);
      else {
        const known =
          e instanceof ProviderCompatibilityError ||
          e instanceof ResponsesToolError;
        res.writeHead(known ? 400 : 502, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(
          JSON.stringify({
            error: {
              code: known ? e.code : `${options.errorPrefix}_TRANSPORT`,
              message: redact(
                e instanceof Error ? e.message : "Provider transport failed",
              ),
              ...(known
                ? {
                    path: e.path,
                    reason: e.reason,
                    ...(e instanceof ResponsesToolError
                      ? { tool: e.tool }
                      : {}),
                  }
                : {}),
            },
          }),
        );
      }
    } finally {
      clearTimeout(timer);
      controller.abort();
      active.delete(controller);
      req.off("aborted", abort);
      res.off("close", abort);
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("upgrade", (_req, socket) => socket.destroy());
  server.headersTimeout = 10000;
  server.requestTimeout = options.deadlineMs ?? 600000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  authority = `127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return {
    endpoint: `http://${authority}`,
    token,
    close() {
      closing ??= new Promise<void>((resolve) => {
        server.close(() => resolve());
        for (const c of active) c.abort(Error("Provider bridge closed"));
        for (const s of sockets) s.destroy();
      });
      return closing;
    },
  };
}

export async function prepareResponsesProcess(
  options: Parameters<typeof prepareAxiomProcess>[0],
  adapter: ResponsesAdapter,
): ReturnType<typeof prepareAxiomProcess> {
  if (options.context !== null)
    throw Error(
      `${adapter.name} context is model-specific, not an Axiom profile override`,
    );
  const token = await options.authorization?.();
  if (!token && !adapter.allowAnonymous)
    throw Error(`Save an ${adapter.name} API key first`);
  const models = await adapter.models(options.endpoint, token),
    model = adapter.validate(
      models,
      options.model,
      options.profile || undefined,
    );
  await mkdir(options.stateDirectory, { recursive: true, mode: 0o700 });
  const cwd = await realpath(options.cwd),
    env = appServerEnvironment(options.stateDirectory);
  const executable =
    options.executable ??
    (await (options.runtime?.executable() ??
      managedCore(options.stateDirectory)));
  const { stdout } = await promisify(execFile)(executable, ["--version"], {
    cwd,
    env,
    timeout: 10000,
    maxBuffer: 65536,
    windowsHide: true,
  });
  if (
    stdout.trim() !==
    `codex-cli ${selectedCoreVersion(options)}`
  )
    throw Error("Pinned Core version mismatch");
  const processCatalog = await createProcessCatalog(options.stateDirectory, {
    models: models
      .filter((m) => !m.unavailableReason)
      .map((m, i) => ({
        slug: m.id,
        // Host instructions for this custom model. Core still supplies its
        // original tool, permission, workspace and collaboration instructions.
        base_instructions:
          "You are an AI coding assistant in Synora Harness Desktop. Work on the user's task using the tools actually provided. Follow the workspace and tool instructions, request approval when required, and report completed work and failures accurately. Never invent tool results or claim execution without evidence.",
        display_name: m.id,
        description: m.providerModel!.description,
        ...(m.default_reasoning_effort
          ? { default_reasoning_level: m.default_reasoning_effort }
          : {}),
        supported_reasoning_levels: m.reasoning_efforts.map((effort) => ({
          effort,
          description: `${adapter.name} ${effort}`,
        })),
        shell_type: "unified_exec",
        visibility: "list",
        supported_in_api: true,
        priority: i,
        availability_nux: null,
        upgrade: null,
        support_verbosity: false,
        default_verbosity: null,
        apply_patch_tool_type: "freeform",
        truncation_policy: { mode: "bytes", limit: 10000 },
        context_window: m.context_window,
        max_context_window: m.context_window,
        effective_context_window_percent: 95,
        experimental_supported_tools: [],
        input_modalities: m.providerModel!.inputModalities.filter((v) =>
          ["text", "image"].includes(v),
        ),
        supports_search_tool: false,
        use_responses_lite: false,
        supports_reasoning_summary_parameter: false,
        include_skills_usage_instructions: true,
        include_plugin_usage_instructions: true,
        tool_mode: "code_mode",
        node_repl_disabled: false,
      })),
  });
  let bridge: Awaited<ReturnType<ResponsesAdapter["bridge"]>> | undefined;
  const cleanup = processResourceCleanup(
    () => bridge?.close(),
    processCatalog.cleanup,
  );
  try {
    const prefix = `model_providers.${adapter.id}`;
    const config = {
      ...(await mcpConfiguration(
        options.integrations ?? [],
        options.stateDirectory,
      )),
      model_catalog_json: processCatalog.path,
      model: model.id,
      model_provider: adapter.id,
      ...(options.profile ? { model_reasoning_effort: options.profile } : {}),
      [`${prefix}.name`]: `${adapter.name}`,
      [`${prefix}.wire_api`]: "responses",
      [`${prefix}.requires_openai_auth`]: false,
      [`${prefix}.supports_websockets`]: false,
      [`${prefix}.request_max_retries`]: 0,
      [`${prefix}.stream_max_retries`]: 0,
      [`${prefix}.stream_idle_timeout_ms`]: 180000,
      "analytics.enabled": false,
      "feedback.enabled": false,
      "features.request_permissions_tool": true,
      web_search: "disabled",
    };
    bridge = await adapter.bridge({
      endpoint: options.endpoint,
      token: token ?? "",
      model,
    });
    env[PROVIDER_TOKEN_ENV] = bridge.token;
    return {
      executable,
      cwd,
      env,
      models,
      cleanup,
      args: [
        "app-server",
        "--stdio",
        ...Object.entries({
          ...config,
          [`${prefix}.base_url`]: bridge.endpoint,
          [`${prefix}.env_http_headers.${PROVIDER_TOKEN_HEADER}`]:
            PROVIDER_TOKEN_ENV,
        }).flatMap(([k, v]) => ["-c", `${k}=${JSON.stringify(v)}`]),
      ],
    };
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        "Provider preparation and cleanup failed",
        {
          cause: error,
        },
      );
    }
    throw error;
  }
}
