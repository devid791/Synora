import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";
import { LocalService, type BrowserService, type Host } from "../main/service";
import { WebBrowser } from "./browser";
import { operations } from "../shared/operations";
import { IMAGE_UPLOAD_JSON_BYTES } from "../shared/image-attachments";
import type { DesktopEvent } from "../shared/contracts";

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";
type Options = {
  openRouterExchange?: Host["openRouterExchange"];
  googleOAuthTransport?: Host["googleOAuthTransport"];
  coreUpdateOptions?: import("../engine/core-updater").CoreUpdaterOptions;
  storePath: string;
  assets: string;
  port?: number;
  browserExecutable?: string;
  browserFactory?: (
    emit: (e: DesktopEvent) => void,
    port: () => number,
  ) => BrowserService;
  speed?: number;
};
export async function startWebService(options: Options) {
  const streams = new Set<ServerResponse>();
  const journal: Array<{ id: number; event: DesktopEvent }> = [];
  let sequence = 0,
    port = 0,
    closing = false;
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const cookieName = "synora_local";
  const emit = (event: DesktopEvent) => {
    // Disposal itself emits state changes. Ended SSE responses must never receive
    // these final events (nor callbacks from a browser tab closing asynchronously).
    if (closing) return;
    const record = { id: ++sequence, event };
    journal.push(record);
    if (journal.length > 2000) journal.shift();
    const data = `id: ${record.id}\ndata: ${JSON.stringify(event)}\n\n`;
    for (const stream of streams) {
      if (stream.destroyed || stream.writableEnded) {
        streams.delete(stream);
        continue;
      }
      // Bounded backpressure: reconnect uses the journal or an authoritative snapshot.
      if (stream.writableLength > 1024 * 1024) {
        stream.destroy();
        streams.delete(stream);
      } else stream.write(data);
    }
  };
  const browser =
    options.browserFactory?.(emit, () => port) ??
    new WebBrowser(emit, () => port, options.browserExecutable);
  const unsupported = () => {
    throw new Error("Native dialogs are unavailable in the web adapter");
  };
  const host: Host = {
    openRouterExchange: options.openRouterExchange,
    googleOAuthTransport: options.googleOAuthTransport,
    capabilities: {
      platform: "web",
      transport: "local-http",
      nativeDialogs: false,
      terminal: true,
      embeddedBrowser: true,
      browserPresentation: "remote-frame",
      engine: "simulated",
      liveInference: false,
    },
    closeReady: () => {},
    chooseWorkspace: async (path) => {
      if (!path || !isAbsolute(path))
        throw new Error(
          "Enter an absolute folder path on the Synora service host",
        );
      return path;
    },
    importPreset: async () => unsupported(),
    exportPreset: async () => unsupported(),
    browser,
  };
  const service = new LocalService(
    options.storePath,
    host,
    emit,
    options.speed,
    options.coreUpdateOptions,
  );
  const root = await realpath(options.assets);
  const origin = () => `http://127.0.0.1:${port}`;
  const json = (res: ServerResponse, status: number, value: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(value));
  };
  const fail = (
    res: ServerResponse,
    status: number,
    code: string,
    message: string,
  ) => json(res, status, { ok: false, error: { code, message } });
  const sameOrigin = (req: IncomingMessage) =>
    req.headers.origin
      ? req.headers.origin === origin()
      : req.headers["sec-fetch-site"] === "same-origin";
  const sessionFor = (req: IncomingMessage) => {
    const id = req.headers.cookie
      ?.split(";")
      .map((v) => v.trim())
      .find((v) => v.startsWith(cookieName + "="))
      ?.slice(cookieName.length + 1);
    const session = id ? sessions.get(id) : undefined;
    if (!session || session.expires < Date.now()) {
      if (id) sessions.delete(id);
      return;
    }
    return session;
  };
  const server = createServer((req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Content-Security-Policy", CSP);
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    void (async () => {
      if (closing)
        return fail(res, 503, "SERVICE_CLOSING", "Local service is closing");
      if (req.headers.host !== `127.0.0.1:${port}`)
        return fail(
          res,
          403,
          "INVALID_HOST",
          "Use the exact local Synora address",
        );
      if (req.headers.origin && req.headers.origin !== origin())
        return fail(
          res,
          403,
          "INVALID_ORIGIN",
          "Cross-origin access is not allowed",
        );
      const path = new URL(req.url || "/", origin()).pathname;
      if (path.startsWith("/api/")) {
        if (!sameOrigin(req))
          return fail(
            res,
            403,
            "INVALID_ORIGIN",
            "Same-origin browser access is required",
          );
        if (path === "/api/bootstrap" && req.method === "GET") {
          for (const [key, s] of sessions)
            if (s.expires < Date.now()) sessions.delete(key);
          let session = sessionFor(req);
          if (!session) {
            if (sessions.size >= 128)
              return fail(
                res,
                429,
                "SESSION_CAPACITY",
                "Close unused browser sessions or restart the local service",
              );
            const id = randomBytes(32).toString("hex");
            session = {
              csrf: randomBytes(32).toString("hex"),
              expires: Date.now() + 24 * 60 * 60 * 1000,
            };
            sessions.set(id, session);
            res.setHeader(
              "Set-Cookie",
              `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/api; Max-Age=86400`,
            );
          }
          return json(res, 200, { csrf: session.csrf });
        }
        const session = sessionFor(req);
        if (!session || req.headers["x-synora-csrf"] !== session.csrf)
          return fail(
            res,
            403,
            "INVALID_SESSION",
            "Refresh this local Synora page to reconnect",
          );
        if (path === "/api/events" && req.method === "GET") {
          const raw = req.headers["last-event-id"] ?? "0",
            after = Number(raw);
          if (
            typeof raw !== "string" ||
            !/^\d+$/.test(raw) ||
            !Number.isSafeInteger(after)
          )
            return fail(res, 400, "INVALID_CURSOR", "Invalid event cursor");
          res.writeHead(200, {
            "Content-Type": "text/event-stream",
            "X-Accel-Buffering": "no",
          });
          res.flushHeaders();
          streams.add(res);
          if (
            after === 0 ||
            after > sequence ||
            after < (journal[0]?.id ?? 1) - 1
          )
            res.write(`id: ${sequence}\ndata: {"kind":"resync"}\n\n`);
          else
            for (const r of journal)
              if (r.id > after)
                res.write(`id: ${r.id}\ndata: ${JSON.stringify(r.event)}\n\n`);
          const timer = setInterval(() => res.write(": keepalive\n\n"), 15000);
          timer.unref();
          res.on("close", () => {
            streams.delete(res);
            clearInterval(timer);
          });
          return;
        }
        const name = path.slice("/api/".length);
        if (req.method !== "POST")
          return fail(
            res,
            405,
            "METHOD_NOT_ALLOWED",
            "Use POST for named local operations",
          );
        if (
          !operations.includes(name as never) ||
          ["closeReady", "presetImport", "presetExport", "clipboardWriteText"].includes(name)
        )
          return fail(res, 404, "UNKNOWN_OPERATION", "No such web operation");
        if (req.headers["content-type"]?.split(";")[0] !== "application/json")
          return fail(res, 415, "INVALID_CONTENT_TYPE", "JSON is required");
        let bytes = 0;
        const chunks: Buffer[] = [];
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          bytes += chunk.length;
          if (
            bytes >
            (name === "imageAttach" ? IMAGE_UPLOAD_JSON_BYTES : 3 * 1024 * 1024)
          ) {
            req.resume();
            return fail(
              res,
              413,
              "REQUEST_TOO_LARGE",
              "Request exceeds the local operation limit",
            );
          }
          chunks.push(chunk);
        }
        let args: unknown;
        try {
          args = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return fail(res, 400, "INVALID_JSON", "Malformed JSON");
        }
        const result = await service.invoke(name, args);
        return json(
          res,
          result.ok
            ? 200
            : result.error.code === "INVALID_OPERATION"
              ? 400
              : 422,
          result,
        );
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        return fail(res, 405, "METHOD_NOT_ALLOWED", "Read-only static assets");
      // Only built assets, never the source tree, SQLite files, or dotfiles.
      const pathname = decodeURIComponent(path),
        parts = pathname.split("/");
      if (parts.some((p) => p.startsWith(".")) || pathname.includes("\\"))
        return fail(res, 404, "NOT_FOUND", "Asset not found");
      const target = await realpath(
        resolve(root, "." + (pathname === "/" ? "/index.html" : pathname)),
      ).catch(() => null);
      if (!target) return fail(res, 404, "NOT_FOUND", "Asset not found");
      const rel = relative(root, target);
      if (rel.startsWith("..") || isAbsolute(rel))
        return fail(res, 404, "NOT_FOUND", "Asset not found");
      const types: Record<string, string> = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript",
        ".css": "text/css",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".woff2": "font/woff2",
      };
      if (!types[extname(target)])
        return fail(res, 404, "NOT_FOUND", "Asset not found");
      const data = await readFile(target);
      res.writeHead(200, { "Content-Type": types[extname(target)] });
      res.end(req.method === "HEAD" ? undefined : data);
    })().catch(() => {
      if (!res.headersSent)
        fail(
          res,
          500,
          "LOCAL_SERVICE_ERROR",
          "The local service could not complete this request",
        );
      else res.end();
    });
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port ?? 0, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (e) {
    await service.dispose();
    throw e;
  }
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Local listener unavailable");
  port = address.port;
  let closingPromise: Promise<void> | undefined;
  return {
    url: origin(),
    service,
    close: () =>
      (closingPromise ??= (async () => {
        closing = true;
        for (const stream of streams) stream.end();
        streams.clear();
        const closed = new Promise<void>((r) => server.close(() => r()));
        server.closeAllConnections();
        await service.dispose();
        await closed;
        sessions.clear();
      })()),
  };
}
