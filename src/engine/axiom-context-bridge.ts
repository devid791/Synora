import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  createServer,
  request as httpRequest,
  type IncomingHttpHeaders,
} from "node:http";
import { request as httpsRequest } from "node:https";
import type { Socket } from "node:net";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import { AxiomTelemetryObserver, requestIdentity } from "./axiom-telemetry";
import type { AxiomRequestMetrics } from "../shared/contracts";
import { bearerHeaders } from "./axiom-auth";
import { axiomImageHistory } from "./axiom-image-history";

export const CONTEXT_TOKEN_HEADER = "x-synora-context-token";
export const CONTEXT_TOKEN_ENV = "SYNORA_CONTEXT_CAPABILITY";

const aliases = [
  "context_window",
  "context_length",
  "max_context",
  "axiom_context_window",
];
class BridgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

/** Axiom wire compatibility, without reserializing any original IDs or arguments. */
export function contextBody(
  raw: Buffer,
  context: number,
  model: string,
): Buffer {
  let source: string, body: Record<string, unknown>;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    body = JSON.parse(source);
  } catch {
    throw new BridgeError(
      "INVALID_JSON",
      "Axiom request must be valid UTF-8 JSON",
    );
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new BridgeError(
      "INVALID_REQUEST",
      "Axiom request must be a JSON object",
    );
  if (body.model !== model)
    throw new BridgeError(
      "MODEL_MISMATCH",
      "Request model differs from the selected Axiom model",
    );
  for (const name of aliases)
    if (Object.hasOwn(body, name) && body[name] !== context)
      throw new BridgeError(
        "CONTEXT_MISMATCH",
        `Request ${name} differs from the selected context`,
      );
  const compatible = axiomImageHistory(source, body);
  if (Object.hasOwn(body, "context_window")) return compatible === source ? raw : Buffer.from(compatible);
  source = compatible;
  const start = source.indexOf("{") + 1;
  // JSON.parse above proves the envelope. Retain its complete source, including
  // numeric spellings, call/item IDs, tools, results, instructions and metadata.
  // The only other edit is the Axiom image-history discriminator above.
  return Buffer.from(
    `${source.slice(0, start)}"context_window":${context},${source.slice(start)}`,
  );
}

function endToEnd(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const blocked = new Set([
    "connection",
    "keep-alive",
    "proxy-authenticate",
    "proxy-authorization",
    "te",
    "trailer",
    "transfer-encoding",
    "upgrade",
    "host",
    CONTEXT_TOKEN_HEADER,
    ...(headers.connection ?? "")
      .toLowerCase()
      .split(",")
      .map((v) => v.trim()),
  ]);
  return Object.fromEntries(
    Object.entries(headers).filter(([key]) => !blocked.has(key)),
  );
}

/** Private per-Core HTTP adapter. Never a public listener or general-purpose proxy. */
export async function axiomContextBridge(options: {
  endpoint: string;
  bearerToken?: string;
  model: string;
  context: number;
  // Host-side qualification controls, not renderer fields.
  deadlineMs?: number;
  responseStartTimeoutMs?: number;
  streamIdleTimeoutMs?: number;
  maxRequestBytes?: number;
  onMetrics?: (value: AxiomRequestMetrics) => void;
}) {
  const upstream = new URL(options.endpoint);
  const authorization = bearerHeaders(options.endpoint, options.bearerToken);
  if (
    !["http:", "https:"].includes(upstream.protocol) ||
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    !upstream.pathname.replace(/\/$/, "").endsWith("/codex/v1")
  )
    throw new Error("Context bridge requires an exact Axiom /codex/v1 URL");
  if (
    !Number.isSafeInteger(options.context) ||
    options.context <= 0 ||
    !options.model
  )
    throw new Error("Invalid context bridge selection");
  const token = randomBytes(32).toString("hex"),
    secret = Buffer.from(token);
  const sockets = new Set<Socket>(),
    requests = new Set<AbortController>();
  let authority = "",
    closing: Promise<void> | undefined;
  const server = createServer(async (req, res) => {
    const controller = new AbortController();
    requests.add(controller);
    let timer = setTimeout(
      () =>
        controller.abort(
          new BridgeError(
            "UPSTREAM_DEADLINE",
            "Axiom request exceeded its deadline",
            504,
          ),
        ),
      options.deadlineMs ?? options.responseStartTimeoutMs ?? 600000,
    );
    const abort = () =>
      controller.abort(new Error("Owned Core connection closed"));
    controller.signal.addEventListener(
      "abort",
      () => {
        if (!req.complete) req.destroy();
      },
      { once: true },
    );
    req.once("aborted", abort);
    res.once("close", abort);
    try {
      const offered = req.headers[CONTEXT_TOKEN_HEADER];
      if (
        closing ||
        req.headers.host !== authority ||
        req.headers.origin ||
        typeof offered !== "string" ||
        Buffer.byteLength(offered) !== secret.length ||
        !timingSafeEqual(Buffer.from(offered), secret)
      )
        throw new BridgeError(
          "PRIVATE_BRIDGE",
          "This endpoint belongs to a Synora Core process",
          403,
        );
      const allowed =
        (req.method === "POST" &&
          ["/responses", "/responses/compact"].includes(req.url ?? "")) ||
        (req.method === "GET" && req.url === "/models");
      if (!allowed)
        throw new BridgeError(
          "UNKNOWN_ROUTE",
          "Unsupported provider operation",
          404,
        );
      if (
        req.headers["content-encoding"] &&
        req.headers["content-encoding"] !== "identity"
      )
        throw new BridgeError(
          "REQUEST_ENCODING",
          "Unsupported Core request encoding",
          415,
        );
      const maxBytes = options.maxRequestBytes ?? 64 * 1024 * 1024;
      if (Number(req.headers["content-length"]) > maxBytes)
        throw new BridgeError(
          "REQUEST_SIZE",
          "Provider request exceeds transport memory bound",
          413,
        );
      let bytes = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        bytes += chunk.length;
        if (bytes > maxBytes)
          throw new BridgeError(
            "REQUEST_SIZE",
            "Provider request exceeds transport memory bound",
            413,
          );
        chunks.push(chunk);
      }
      const raw = Buffer.concat(chunks);
      if (req.method === "GET" && raw.length)
        throw new BridgeError(
          "INVALID_REQUEST",
          "Catalog requests cannot contain a body",
        );
      const body =
        req.url === "/responses"
          ? contextBody(raw, options.context, options.model)
          : raw;
      const headers = endToEnd(req.headers);
      if (options.bearerToken !== undefined) {
        delete headers.authorization;
        headers.authorization = authorization.Authorization;
      }
      headers["content-length"] = String(body.length);
      const url = new URL(`${upstream.href.replace(/\/$/, "")}${req.url}`);
      const response = await new Promise<import("node:http").IncomingMessage>(
        (resolve, reject) => {
          const call = (url.protocol === "https:" ? httpsRequest : httpRequest)(
            url,
            {
              method: req.method,
              headers,
              signal: controller.signal,
            },
            resolve,
          );
          call.once("error", reject);
          call.end(body);
        },
      );
      if (response.statusCode! >= 300 && response.statusCode! < 400) {
        response.resume();
        throw new BridgeError(
          "UPSTREAM_REDIRECT",
          "Axiom redirected the provider request; no alternate origin was contacted",
          502,
        );
      }
      res.writeHead(response.statusCode!, endToEnd(response.headers));
      res.flushHeaders();
      const eventStream = /^text\/event-stream(?:;|$)/i.test(
        response.headers["content-type"] ?? "",
      );
      // Receiving the request/first headers is bounded above. Once a real
      // generation stream starts, activity—not its total age—governs liveness.
      // Explicit host deadlines retain their absolute meaning for qualification.
      const refreshIdle = options.deadlineMs === undefined &&
        req.url === "/responses" && eventStream &&
        response.statusCode! >= 200 && response.statusCode! < 300
        ? () => {
            clearTimeout(timer);
            timer = setTimeout(() => controller.abort(new BridgeError(
              "UPSTREAM_IDLE_TIMEOUT", "Axiom stream stopped responding", 504,
            )), options.streamIdleTimeoutMs ?? 180000);
          }
        : undefined;
      refreshIdle?.();
      // Streaming stays byte-for-byte, incremental and backpressured. No SSE
      // reassembly, retries, synthetic terminal success, or output buffering.
      const identity =
        options.onMetrics && req.url === "/responses"
          ? requestIdentity(raw)
          : undefined;
      const observer = identity && eventStream
        ? new AxiomTelemetryObserver(
          { ...identity, model: options.model },
          options.onMetrics!,
        ) : undefined;
      if (observer || refreshIdle) {
        const tap = new Transform({
          transform(chunk: Buffer, _encoding, callback) {
            this.push(chunk); // Forward first; never wait for a telemetry frame.
            if (chunk.length) refreshIdle?.();
            observer?.write(chunk);
            callback();
          },
        });
        await pipeline(response, tap, res, { signal: controller.signal });
      } else await pipeline(response, res, { signal: controller.signal });
    } catch (error) {
      if (!res.headersSent && !res.destroyed) {
        const reason = controller.signal.reason;
        const known =
          error instanceof BridgeError
            ? error
            : reason instanceof BridgeError
              ? reason
              : null;
        res.writeHead(known?.status ?? 502, {
          "content-type": "application/json",
          connection: "close",
        });
        res.end(
          JSON.stringify({
            error: {
              code: known?.code ?? "UPSTREAM_TRANSPORT",
              message: known?.message ?? "The Axiom upstream connection failed",
              type: "synora_provider_error",
            },
          }),
        );
      } else if (!res.destroyed) res.destroy();
    } finally {
      clearTimeout(timer);
      controller.abort();
      requests.delete(controller);
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
  // Node's requestTimeout bounds receipt of request bodies, not active responses.
  server.requestTimeout = options.deadlineMs ?? options.responseStartTimeoutMs ?? 600000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No context bridge listener");
  authority = `127.0.0.1:${address.port}`;
  return {
    endpoint: `http://${authority}`,
    token,
    close() {
      if (closing) return closing;
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        for (const request of requests) request.abort();
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}
