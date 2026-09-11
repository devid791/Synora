import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo, Socket } from "node:net";
import {
  anthropicFixtureModel,
  nativeEvents,
  nativeSse,
} from "./anthropic-wire";

/** Controlled native protocol, not public model inference. Core executes the
 * read commands and every host delegation/review; this server cannot do either. */
export async function supervisorReworkUpstream(
  workspace: string,
  marker: string,
) {
  const key = `qa-${randomUUID()}`,
    requests: any[] = [],
    errors: string[] = [];
  const sockets = new Set<Socket>(),
    active = new Set<ServerResponse>();
  let seq = 0,
    firstTaskId: string | undefined;
  const toolName = (body: any, original: string) => {
    const t = body.tools.find(
      (t: any) =>
        t.name === original ||
        t.description?.startsWith(`Original Core tool: ${original}\n`),
    );
    assert.ok(t, `Missing mounted tool ${original}`);
    return t.name;
  };
  const result = (body: any, id: string) =>
    body.messages
      .flatMap((m: any) => m.content)
      .find((r: any) => r.type === "tool_result" && r.tool_use_id === id);
  const unpack = (r: any) => {
    assert.ok(r);
    assert.notEqual(r.is_error, true);
    return JSON.parse(
      typeof r.content === "string"
        ? r.content
        : r.content.map((v: any) => v.text ?? "").join(""),
    );
  };
  const listen = async (role: "supervisor" | "worker") => {
    const server = createServer(async (req, res) => {
      try {
        assert.ok(
          req.headers.authorization === `Bearer ${key}`,
          "Controlled credential mismatch",
        );
        if (req.method === "GET") {
          assert.equal(req.url, "/v1/models?limit=1000");
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
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        assert.equal(body.model, anthropicFixtureModel.id);
        assert.deepEqual(body.output_config, { effort: "high" });
        assert.deepEqual(body.thinking, { type: "adaptive" });
        const record = {
          role,
          at: Date.now(),
          body,
          closedAt: undefined as number | undefined,
        };
        requests.push(record);
        assert.ok(requests.length <= 22, "Finite request budget");
        active.add(res);
        res.once("close", () => {
          active.delete(res);
          record.closedAt = Date.now();
        });
        let blocks: any[],
          reason = "tool_use";
        const tool = (name: string, id: string, input: unknown) => [
          { type: "tool_use", name: toolName(body, name), id, input },
        ];
        if (role === "worker") {
          assert.ok(
            !body.tools.some(
              (t: any) =>
                t.name === "synora_delegate" ||
                t.description?.startsWith(
                  "Original Core tool: synora_delegate\n",
                ),
            ),
          );
          const read = result(body, "toolu_rework_read");
          if (!read) {
            const command = body.tools.find(
              (t: any) =>
                /^Original Core tool: (?:functions\.)?exec\n/.test(
                  t.description ?? "",
                ) && t.input_schema.properties?.input?.type === "string",
            );
            assert.ok(
              command,
              "Original worker Core code executor unavailable",
            );
            blocks = [
              {
                type: "tool_use",
                id: "toolu_rework_read",
                name: command.name,
                input: {
                  input: `text(await tools.exec_command(${JSON.stringify({ cmd: "sed -n '1p' read-only.txt", workdir: workspace, max_output_tokens: 200 })}));`,
                },
              },
            ];
          } else {
            assert.notEqual(read.is_error, true);
            assert.ok(
              JSON.stringify(read.content).includes(marker),
              "Original command must return fixture marker",
            );
            const revision = JSON.stringify(body.messages).includes(
              "Prior task evidence for this explicit revision",
            );
            if (revision) {
              assert.ok(
                firstTaskId &&
                  JSON.stringify(body.messages).includes(firstTaskId),
              );
              assert.ok(
                JSON.stringify(body.messages).includes("Add FINAL prefix"),
                "Prior review must reach revised worker",
              );
              assert.ok(
                JSON.stringify(body.messages).includes(`FIRST ${marker}`),
                "Prior result must reach revised worker",
              );
            }
            blocks = [
              {
                type: "text",
                text: `${revision ? "FINAL" : "FIRST"} ${marker}`,
              },
            ];
            reason = "end_turn";
          }
        } else {
          const ack = result(body, "toolu_rework_delegate_first");
          if (!ack)
            blocks = tool("synora_delegate", "toolu_rework_delegate_first", {
              worker_id: "reader",
              name: "Initial result",
              task: "Read read-only.txt once without edits, network or agents. Return FIRST and the exact marker.",
            });
          else {
            const first = unpack(ack);
            firstTaskId = first.task_id;
            const firstReview = result(body, "toolu_rework_review_first");
            if (!firstReview) {
              const waited = body.messages
                .flatMap((m: any) => m.content)
                .filter(
                  (r: any) =>
                    r.type === "tool_result" &&
                    r.tool_use_id.startsWith("toolu_rework_wait_first_"),
                )
                .at(-1);
              const latest = waited ? unpack(waited) : first;
              if (latest.status !== "completed") {
                assert.ok(["queued", "running"].includes(latest.status));
                blocks = tool("synora_wait", `toolu_rework_wait_first_${seq}`, {
                  task_id: firstTaskId,
                });
              } else {
                assert.equal(latest.result, `FIRST ${marker}`);
                blocks = tool("synora_review", "toolu_rework_review_first", {
                  task_id: firstTaskId,
                  verdict: "changes_requested",
                  summary:
                    "Add FINAL prefix to the verified marker. Preserve the original result.",
                });
              }
            } else {
              const reviewed = unpack(firstReview);
              assert.equal(reviewed.review.verdict, "changes_requested");
              const revision = result(body, "toolu_rework_delegate_revision");
              if (!revision)
                blocks = tool(
                  "synora_delegate",
                  "toolu_rework_delegate_revision",
                  {
                    worker_id: "reader",
                    name: "Revised result",
                    task: "Read read-only.txt once without edits, network or agents. Apply the recorded review and return FINAL and the exact marker.",
                    revises_task_id: firstTaskId,
                  },
                );
              else {
                const second = unpack(revision);
                assert.notEqual(second.task_id, firstTaskId);
                assert.equal(second.revises_task_id, firstTaskId);
                const accepted = result(body, "toolu_rework_review_revision");
                if (accepted) {
                  assert.equal(unpack(accepted).review.verdict, "accepted");
                  blocks = [{ type: "text", text: `FINAL ${marker}` }];
                  reason = "end_turn";
                } else {
                  const waited = body.messages
                    .flatMap((m: any) => m.content)
                    .filter(
                      (r: any) =>
                        r.type === "tool_result" &&
                        r.tool_use_id.startsWith("toolu_rework_wait_revision_"),
                    )
                    .at(-1);
                  const latest = waited ? unpack(waited) : second;
                  if (latest.status !== "completed") {
                    assert.ok(["queued", "running"].includes(latest.status));
                    blocks = tool(
                      "synora_wait",
                      `toolu_rework_wait_revision_${seq}`,
                      { task_id: second.task_id },
                    );
                  } else {
                    assert.equal(latest.result, `FINAL ${marker}`);
                    blocks = tool(
                      "synora_review",
                      "toolu_rework_review_revision",
                      {
                        task_id: second.task_id,
                        verdict: "accepted",
                        summary: `Revised result matches FINAL ${marker}; initial task and review remain unchanged.`,
                      },
                    );
                  }
                }
              }
            }
          }
        }
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(nativeSse(nativeEvents(`msg_rework_${++seq}`, blocks, reason)));
      } catch (error) {
        errors.push(String(error).split(key).join("[QA_KEY]"));
        res.destroy();
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    return server;
  };
  const servers = await Promise.all([listen("supervisor"), listen("worker")]);
  const endpoint = (server: (typeof servers)[number]) =>
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return {
    key,
    model: anthropicFixtureModel.id,
    supervisorEndpoint: endpoint(servers[0]),
    workerEndpoint: endpoint(servers[1]),
    requests,
    errors,
    diagnostics: () => ({ sockets: sockets.size, active: active.size }),
    // Node's catalog fetch pool may retain completed idle connections. The QA
    // server may retire only those; active streams must already be settled.
    retireIdleConnections: () => {
      assert.equal(active.size, 0);
      for (const server of servers) server.closeIdleConnections();
    },
    close: async () => {
      await Promise.all(
        servers.map(async (server) => {
          server.closeAllConnections();
          await new Promise<void>((r) => server.close(() => r()));
        }),
      );
    },
  };
}
