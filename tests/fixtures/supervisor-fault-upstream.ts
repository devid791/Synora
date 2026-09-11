import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import {
  anthropicFixtureModel,
  nativeEvents,
  nativeSse,
} from "./anthropic-wire";

export type SupervisorFault = "stall" | "http503" | "malformed";
export type SupervisorFaultCase =
  | "deadline-stall"
  | "http503"
  | "malformed"
  | "parent-cancel"
  | "worker-cancel"
  | "tool-cancel";
type Role = "supervisor" | "worker";
export interface FaultRequest {
  role: Role;
  at: number;
  closedAt?: number;
  stage?: string;
  status?: number;
  bodySha256: string;
  body: any;
  forwarded: false;
}

/** Controlled native Messages ONLY, never forwards to a model/GPU/public account.
 * Both host delegation and the read command are executed by real pinned Core.
 * Fault injection follows a verified original worker Core command result.
 */
export async function supervisorFaultUpstream(options: {
  scenario: SupervisorFaultCase;
  workspace: string;
  marker: string;
}) {
  const key = `qa-supervisor-fault-${randomUUID()}`;
  const requests: FaultRequest[] = [],
    errors: string[] = [];
  const sockets = new Set<Socket>(),
    active = new Set<ServerResponse>();
  const fault: SupervisorFault =
    options.scenario === "http503"
      ? "http503"
      : options.scenario === "malformed"
        ? "malformed"
        : "stall";
  let delegated = false,
    readIssued = false,
    waits = 0,
    cancelIssued = false;
  let faultReady!: () => void;
  const faultArrived = new Promise<void>((resolve) => {
    faultReady = resolve;
  });
  const outcomes: any[] = [];
  const state = {
    faultRequests: 0,
    closedFaultStreams: 0,
    toolResult: undefined as any,
  };
  const partial = `CONTROLLED_PARTIAL_${options.marker}`;
  const toolName = (body: any, original: string) => {
    const tool = body.tools.find(
      (t: any) =>
        t.name === original ||
        t.description?.startsWith(`Original Core tool: ${original}\n`),
    );
    assert.ok(tool, `Missing original Core host tool ${original}`);
    return tool.name as string;
  };
  const results = (body: any) =>
    body.messages
      .flatMap((m: any) => m.content)
      .filter((b: any) => b.type === "tool_result");
  const unpack = (result: any) => {
    assert.notEqual(
      result.is_error,
      true,
      "Original Core host tool returned an error",
    );
    return JSON.parse(
      typeof result.content === "string"
        ? result.content
        : result.content.map((b: any) => b.text ?? "").join(""),
    );
  };
  const send = (res: ServerResponse, blocks: any[], reason = "end_turn") => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      nativeSse(nativeEvents(`msg_fault_${requests.length}`, blocks, reason)),
    );
  };
  const makeServer = (role: Role) => {
    const server = createServer(async (req, res) => {
      let record: FaultRequest | undefined;
      try {
        // Do not include even generated QA keys in failed assertion receipts.
        assert.ok(
          req.headers.authorization === `Bearer ${key}`,
          "QA authorization mismatch",
        );
        assert.equal(req.headers["anthropic-version"], "2023-06-01");
        if (req.method === "GET" && req.url === "/v1/models?limit=1000") {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              data: [anthropicFixtureModel],
              has_more: false,
              last_id: anthropicFixtureModel.id,
            }),
          );
          return;
        }
        assert.equal(req.method, "POST");
        assert.equal(req.url, "/v1/messages");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of req) {
          size += chunk.length;
          assert.ok(size <= 4 * 1024 * 1024, "QA request size bound");
          chunks.push(Buffer.from(chunk));
        }
        const raw = Buffer.concat(chunks),
          body = JSON.parse(raw.toString());
        record = {
          role,
          at: Date.now(),
          bodySha256: createHash("sha256").update(raw).digest("hex"),
          body,
          forwarded: false,
        };
        requests.push(record);
        active.add(res);
        res.once("close", () => {
          active.delete(res);
          record!.closedAt = Date.now();
        });
        assert.ok(
          requests.filter((r) => r.role === role).length <= 10,
          "Finite provider request budget exceeded",
        );
        assert.equal(body.model, anthropicFixtureModel.id);
        assert.equal(body.stream, true);
        assert.deepEqual(body.output_config, { effort: "high" });
        assert.deepEqual(body.thinking, { type: "adaptive" });
        if (role === "worker") {
          // Workers must not recursively receive the supervisor-only delegation catalog.
          assert.ok(
            !body.tools.some(
              (t: any) =>
                /synora_delegate/.test(t.name) ||
                t.description?.startsWith(
                  "Original Core tool: synora_delegate\n",
                ),
            ),
          );
          if (!readIssued) {
            readIssued = true;
            record.stage = "actual-core-read";
            const exec = body.tools.find(
              (t: any) =>
                /^Original Core tool: (?:functions\.)?exec\n/.test(
                  t.description ?? "",
                ) && t.input_schema.properties?.input?.type === "string",
            );
            assert.ok(
              exec,
              "Worker original Core code-mode executor not advertised",
            );
            send(
              res,
              [
                {
                  type: "tool_use",
                  id: "toolu_fault_worker_read",
                  name: exec.name,
                  input: {
                    input: `text(await tools.exec_command(${JSON.stringify({
                      cmd: "sed -n '1p' read-only.txt",
                      workdir: options.workspace,
                      max_output_tokens: 200,
                    })}));`,
                  },
                },
              ],
              "tool_use",
            );
            return;
          }
          const result = results(body).find(
            (r: any) => r.tool_use_id === "toolu_fault_worker_read",
          );
          assert.ok(result, "Missing actual worker Core command result");
          assert.ok(
            JSON.stringify(result.content).includes(options.marker),
            "Worker did not read the original QA marker",
          );
          state.toolResult = result;
          state.faultRequests++;
          record.stage = fault;
          record.status = fault === "http503" ? 503 : 200;
          res.once("close", () => {
            state.closedFaultStreams++;
          });
          if (fault === "http503") {
            res.writeHead(503, { "content-type": "application/json" });
            res.end(
              JSON.stringify({
                error: {
                  code: "CONTROLLED_QA_503",
                  message:
                    "Controlled local worker unavailable; no public inference",
                },
              }),
            );
          } else {
            res.writeHead(200, { "content-type": "text/event-stream" });
            res.flushHeaders();
            if (fault === "malformed")
              res.end("event: message_delta\ndata: {INVALID_NATIVE_JSON}\n\n");
            else {
              const frames = nativeEvents(
                `msg_worker_partial_${state.faultRequests}`,
                [{ type: "text", text: partial }],
              );
              // Deliver real partial data, but deliberately omit all terminal frames.
              res.write(
                nativeSse(
                  frames.filter(
                    (e: any) =>
                      ![
                        "content_block_stop",
                        "message_delta",
                        "message_stop",
                      ].includes(e.type),
                  ),
                ),
              );
            }
          }
          faultReady();
          return;
        }
        if (!delegated) {
          delegated = true;
          record.stage = "delegate";
          send(
            res,
            [
              {
                type: "tool_use",
                id: "toolu_fault_delegate",
                name: toolName(body, "synora_delegate"),
                input: {
                  worker_id: "reader",
                  name: "Controlled fault worker",
                  task: "Read read-only.txt once with a read-only command. Do not write files, use the network or delegate. Then report the exact marker.",
                },
              },
            ],
            "tool_use",
          );
          return;
        }
        const received = results(body);
        const ack = received.find(
          (r: any) => r.tool_use_id === "toolu_fault_delegate",
        );
        assert.ok(ack, "Supervisor did not receive real Core delegation ACK");
        const original = unpack(ack);
        assert.ok(
          original.task_id,
          "Delegation ACK must include the original task ID",
        );
        const waited = received
          .filter(
            (r: any) =>
              r.tool_use_id.startsWith("toolu_fault_wait_") ||
              r.tool_use_id === "toolu_fault_cancel",
          )
          .at(-1);
        const latest = waited ? unpack(waited) : original;
        assert.equal(latest.task_id, original.task_id);
        if (!["queued", "running"].includes(latest.status)) {
          assert.ok(
            ["failed", "cancelled"].includes(latest.status),
            `Unexpected worker outcome ${latest.status}`,
          );
          assert.ok(
            latest.error,
            "A fault/cancel must have an explicit outcome reason",
          );
          outcomes.push(latest);
          record.stage = "observed-worker-outcome";
          send(res, [
            {
              type: "text",
              text: `CONTROLLED_WORKER_OUTCOME task=${latest.task_id} status=${latest.status}; ${latest.error}`,
            },
          ]);
        } else if (options.scenario === "tool-cancel" && !cancelIssued) {
          cancelIssued = true;
          // Wait for the real worker command before asking Core to execute cancel.
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([
              faultArrived,
              new Promise<never>((_, reject) => {
                timer = setTimeout(
                  () => reject(Error("Worker fault admission deadline")),
                  15000,
                );
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          if (res.destroyed) return;
          record.stage = "cancel";
          send(
            res,
            [
              {
                type: "tool_use",
                id: "toolu_fault_cancel",
                name: toolName(body, "synora_cancel"),
                input: { task_id: original.task_id },
              },
            ],
            "tool_use",
          );
        } else {
          assert.ok(waits < 4, "Finite synora_wait budget exceeded");
          record.stage = "wait";
          send(
            res,
            [
              {
                type: "tool_use",
                id: `toolu_fault_wait_${waits++}`,
                name: toolName(body, "synora_wait"),
                input: { task_id: original.task_id },
              },
            ],
            "tool_use",
          );
        }
      } catch (error) {
        errors.push(String(error).split(key).join("[QA_KEY_REDACTED]"));
        res.destroy();
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    return server;
  };
  const servers = [makeServer("supervisor"), makeServer("worker")];
  try {
    for (const server of servers)
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
  } catch (error) {
    for (const server of servers) server.close();
    throw error;
  }
  let closing: Promise<void> | undefined;
  return {
    key,
    model: anthropicFixtureModel.id,
    partial,
    requests,
    errors,
    outcomes,
    state,
    supervisorEndpoint: `http://127.0.0.1:${(servers[0].address() as AddressInfo).port}/v1`,
    workerEndpoint: `http://127.0.0.1:${(servers[1].address() as AddressInfo).port}/v1`,
    ports: servers.map((s) => (s.address() as AddressInfo).port),
    activeCount: () => active.size,
    socketCount: () => sockets.size,
    close: () =>
      (closing ??= Promise.all(
        servers.map(
          (server) =>
            new Promise<void>((resolve, reject) => {
              server.close((error) => (error ? reject(error) : resolve()));
              server.closeAllConnections();
            }),
        ),
      ).then(() => {})),
  };
}
