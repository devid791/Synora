import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import {
  anthropicFixtureModel,
  nativeEvents,
  nativeSse,
} from "./anthropic-wire";

/** Controlled Anthropic protocol only. The delegated worker is NOT simulated. */
export async function supervisorUpstream() {
  const key = `qa-${randomUUID()}`,
    requests: unknown[] = [],
    errors: string[] = [];
  let taskId: string | undefined,
    seq = 0,
    delegated = false;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.headers.authorization, `Bearer ${key}`);
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
      for await (const c of req) chunks.push(Buffer.from(c));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      requests.push(body);
      assert.equal(body.model, anthropicFixtureModel.id);
      assert.deepEqual(body.output_config, { effort: "high" });
      assert.deepEqual(body.thinking, { type: "adaptive" });
      const tools = body.tools;
      const name = (original: string) => {
        const t = tools.find(
          (t: any) =>
            t.name === original ||
            t.description?.startsWith(`Original Core tool: ${original}\n`),
        );
        assert.ok(t, `Missing dynamic tool ${original}`);
        return t.name;
      };
      const results = body.messages
        .flatMap((m: any) => m.content)
        .filter((x: any) => x.type === "tool_result");
      const readResult = (r: any) =>
        JSON.parse(
          typeof r.content === "string"
            ? r.content
            : r.content.map((b: any) => b.text ?? "").join(""),
        );
      let blocks: any[],
        reason = "tool_use";
      if (!delegated) {
        delegated = true;
        blocks = [
          {
            type: "tool_use",
            id: "toolu_supervisor_delegate",
            name: name("synora_delegate"),
            input: {
              worker_id: "reader",
              name: "Axiom file reader",
              task: "Read read-only.txt with one read-only file command and return its exact contents. Do not write, access the network or spawn agents.",
            },
          },
        ];
      } else {
        const ack = results.find(
          (r: any) => r.tool_use_id === "toolu_supervisor_delegate",
        );
        assert.ok(ack);
        assert.notEqual(ack.is_error, true);
        const record = readResult(ack);
        taskId = record.task_id;
        assert.ok(taskId);
        const waited = results
          .filter((r: any) =>
            r.tool_use_id.startsWith("toolu_supervisor_wait_"),
          )
          .at(-1);
        const latest = waited ? readResult(waited) : record;
        if (latest.status === "completed") {
          assert.match(latest.result, /WORKER_[a-f0-9-]+/);
          const reviewed = results.find(
            (r: any) => r.tool_use_id === "toolu_supervisor_review",
          );
          if (!reviewed) {
            blocks = [
              {
                type: "tool_use",
                id: "toolu_supervisor_review",
                name: name("synora_review"),
                input: {
                  task_id: taskId,
                  verdict: "accepted",
                  summary: `The worker returned the requested marker: ${latest.result.match(/WORKER_[a-f0-9-]+/)[0]}. This controlled supervisor checked the reported result, not an external account.`,
                },
              },
            ];
          } else {
            assert.notEqual(reviewed.is_error, true);
            const decision = readResult(reviewed);
            assert.equal(decision.review.verdict, "accepted");
            assert.equal(decision.review.callId, "toolu_supervisor_review");
            assert.equal(decision.task_id, taskId);
            blocks = [
              {
                type: "text",
                text: latest.result.match(/WORKER_[a-f0-9-]+/)[0],
              },
            ];
            reason = "end_turn";
          }
        } else {
          assert.ok(
            ["queued", "running"].includes(latest.status),
            JSON.stringify(latest),
          );
          assert.ok(seq < 8, "Worker did not settle");
          blocks = [
            {
              type: "tool_use",
              id: `toolu_supervisor_wait_${seq}`,
              name: name("synora_wait"),
              input: { task_id: taskId },
            },
          ];
        }
      }
      seq++;
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(nativeSse(nativeEvents(`msg_supervisor_${seq}`, blocks, reason)));
    } catch (e) {
      errors.push(String(e));
      res.destroy();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return {
    endpoint: `http://127.0.0.1:${(server.address() as any).port}/v1`,
    key,
    model: anthropicFixtureModel.id,
    requests,
    errors,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
