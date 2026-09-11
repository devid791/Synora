// QA-only fault injector. Never imported by application or release bundles.
import { createServer, request, type ServerResponse } from "node:http";
import { createHash } from "node:crypto";
import type { Socket } from "node:net";
import { StringDecoder } from "node:string_decoder";

export type FaultMode =
  | "normal"
  | "http503"
  | "malformed"
  | "truncated"
  | "stall";
export async function axiomFaultRelay(endpoint: string) {
  const target = new URL(endpoint);
  if (target.protocol !== "http:" || target.pathname !== "/codex/v1")
    throw Error(
      "Explicit private HTTP Axiom bridge required for this QA relay",
    );
  let mode: FaultMode = "normal";
  const sockets = new Set<Socket>();
  const active = new Set<ServerResponse>();
  const records: Array<{
    mode: FaultMode;
    startedAt: number;
    closedAt?: number;
    status?: number;
    sessionId?: string;
    turnId?: string;
    bodySha: string;
    bytes: number;
    forwarded: boolean;
    events: string[];
    firstDelta?: string;
  }> = [];
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = [];
    for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const raw = Buffer.concat(buffers);
    const responsePath = new URL(
      req.url!,
      "http://qa.invalid",
    ).pathname.endsWith("/responses");
    const selected = responsePath ? mode : "normal";
    const record = {
      mode: selected,
      startedAt: Date.now(),
      bodySha: createHash("sha256").update(raw).digest("hex"),
      bytes: raw.length,
      forwarded: selected === "normal" || selected === "truncated",
      events: [] as string[],
      sessionId: req.headers.session_id as string | undefined,
      turnId: req.headers["x-codex-turn-metadata"] as string | undefined,
    } as (typeof records)[number];
    if (responsePath) {
      records.push(record);
      active.add(res);
    }
    res.once("close", () => {
      active.delete(res);
      record.closedAt = Date.now();
    });
    if (selected === "http503") {
      record.status = 503;
      res.writeHead(503, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            code: "SYNORA_QA_UNAVAILABLE",
            message: "Controlled QA upstream unavailable",
          },
        }),
      );
      return;
    }
    if (selected === "malformed" || selected === "stall") {
      record.status = 200;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      if (selected === "malformed")
        res.end('data: {"type":"response.completed","response":INVALID}\n\n');
      else res.write(": controlled QA idle stream, no model request\n\n");
      return;
    }
    const headers = { ...req.headers };
    for (const k of ["host", "connection", "transfer-encoding"])
      delete headers[k];
    const upstream = request(
      new URL(req.url!, target.origin),
      {
        method: req.method,
        headers,
      },
      (incoming) => {
        record.status = incoming.statusCode;
        const outgoing = { ...incoming.headers };
        for (const k of ["connection", "transfer-encoding", "content-length"])
          delete outgoing[k];
        res.writeHead(incoming.statusCode!, outgoing);
        const decoder = new StringDecoder("utf8");
        let pending = "";
        incoming.on("data", (chunk: Buffer) => {
          if (res.writableEnded || res.destroyed) return;
          if (!responsePath) {
            res.write(chunk);
            return;
          }
          pending += decoder.write(chunk);
          for (
            let end = pending.indexOf("\n\n");
            end >= 0;
            end = pending.indexOf("\n\n")
          ) {
            const frame = pending.slice(0, end + 2);
            pending = pending.slice(end + 2);
            const data = frame
              .split("\n")
              .filter((s) => s.startsWith("data:"))
              .map((s) => s.slice(5).trim())
              .join("\n");
            let e: { type?: string; delta?: string } = {};
            try {
              e = JSON.parse(data);
            } catch {
              /* Preserve unknown frames verbatim. */
            }
            if (e.type) record.events.push(e.type);
            res.write(frame);
            if (e.type === "response.output_text.delta" && e.delta) {
              record.firstDelta ??= e.delta;
              if (selected === "truncated") {
                res.end();
                incoming.destroy();
                upstream.destroy();
                return;
              }
            }
          }
        });
        incoming.on("end", () => {
          if (!res.writableEnded) res.end(pending + decoder.end());
        });
        incoming.on("error", () => {
          if (!res.writableEnded) res.destroy();
        });
      },
    );
    upstream.once("error", (error) => {
      if (!res.headersSent) {
        res.writeHead(502);
        res.end(error.message);
      } else if (!res.writableEnded) res.destroy();
    });
    res.once("close", () => upstream.destroy());
    upstream.end(raw);
  });
  server.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as { port: number }).port}/codex/v1`,
    setMode: (value: FaultMode) => {
      mode = value;
    },
    records,
    activeCount: () => active.size,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
