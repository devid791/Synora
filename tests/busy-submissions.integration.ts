// Original Core, deterministic loopback Responses stream. Tests actual steer
// delivery/identity, not Qwen inference or the timing of a remote model.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { AppServerTransport } from "../src/engine/app-server-transport";
import { appServerEnvironment } from "../src/engine/axiom-process";

async function until(fn: () => boolean) {
  const deadline = Date.now() + 15000;
  while (!fn()) {
    if (Date.now() > deadline)
      throw Error("Original Core busy-input check timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test(
  "Original Core accepts steer during streaming and delivers it upstream within the same turn",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "synora-busy-core-"));
    await mkdir(join(root, "core"));
    const requests: any[] = [],
      notifications: any[] = [],
      errors: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const upstream = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        let bytes: Buffer = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip")
          bytes = gunzipSync(bytes);
        if (req.headers["content-encoding"] === "zstd")
          bytes = zstdDecompressSync(bytes);
        assert.equal(req.url, "/responses");
        const body = JSON.parse(bytes.toString());
        requests.push(body);
        const index = requests.length;
        assert.ok(
          index <= 2,
          "Steer must not silently retry or create more work",
        );
        const response = {
          id: `resp_busy_${index}`,
          object: "response",
          model: body.model,
          status: "in_progress",
          output: [],
        };
        const send = (type: string, data: any) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
          );
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        send("response.created", { response });
        send("response.in_progress", { response });
        const part = {
          type: "output_text",
          text:
            index === 1
              ? "CONTROLLED original response"
              : "CONTROLLED guidance received",
          annotations: [],
        };
        const item = {
          id: `msg_busy_${index}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [part],
        };
        send("response.output_item.added", {
          output_index: 0,
          item: { ...item, status: "in_progress", content: [] },
        });
        send("response.content_part.added", {
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          part: { ...part, text: "" },
        });
        send("response.output_text.delta", {
          output_index: 0,
          item_id: item.id,
          content_index: 0,
          delta: part.text,
        });
        if (index === 1)
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        send("response.output_item.done", { output_index: 0, item });
        send("response.completed", {
          response: {
            ...response,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
          },
        });
        res.end();
      } catch (e) {
        errors.push(String(e));
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((resolve) =>
      upstream.listen(0, "127.0.0.1", resolve),
    );
    const config = {
      model_provider: "qa",
      "model_providers.qa.name": "Controlled busy-message qualification",
      "model_providers.qa.base_url": `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
      "model_providers.qa.wire_api": "responses",
      "model_providers.qa.requires_openai_auth": false,
      "model_providers.qa.request_max_retries": 0,
      "model_providers.qa.stream_max_retries": 0,
      "model_providers.qa.stream_idle_timeout_ms": 20000,
      "analytics.enabled": false,
      "feedback.enabled": false,
    };
    const rpc = new AppServerTransport({
      executable: process.env.SYNORA_TEST_CORE ?? "codex",
      args: [
        "app-server",
        "--stdio",
        ...Object.entries(config).flatMap(([k, v]) => [
          "-c",
          `${k}=${JSON.stringify(v)}`,
        ]),
      ],
      cwd: root,
      env: appServerEnvironment(join(root, "core")),
      onNotification: (e) => {
        notifications.push(e);
      },
      onRequest: () => {
        throw Error(
          "No tools or approvals are part of this controlled protocol check",
        );
      },
      onClose: () => {},
    });
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "synora_busy_qa", version: "1" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      const thread: any = await rpc.request("thread/start", {
        cwd: root,
        model: "gpt-5",
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      const first: any = await rpc.request("turn/start", {
        threadId: thread.thread.id,
        input: [
          {
            type: "text",
            text: "Controlled protocol check; no real inference.",
            text_elements: [],
          },
        ],
      });
      await until(() => !!releaseFirst);
      assert.equal(
        notifications.filter((e) => e.method === "turn/completed").length,
        0,
      );
      const clientUserMessageId = randomUUID();
      const response: any = await rpc.request(
        "turn/steer",
        {
          threadId: thread.thread.id,
          expectedTurnId: first.turn.id,
          clientUserMessageId,
          input: [
            {
              type: "text",
              text: "BUSY_GUIDANCE_MARKER_7C42",
              text_elements: [],
            },
          ],
        },
        5000,
      );
      assert.equal(response.turnId, first.turn.id);
      assert.equal(
        notifications.filter((e) => e.method === "turn/completed").length,
        0,
        "Steer is accepted without waiting for turn completion",
      );
      releaseFirst!();
      await until(() =>
        notifications.some((e) => e.method === "turn/completed"),
      );
      assert.deepEqual(errors, []);
      assert.equal(requests.length, 2);
      assert.match(
        JSON.stringify(requests[1].input),
        /BUSY_GUIDANCE_MARKER_7C42/,
      );
      const started = notifications.filter((e) => e.method === "turn/started");
      const ended = notifications.filter((e) => e.method === "turn/completed");
      assert.equal(started.length, 1);
      assert.equal(ended.length, 1);
      assert.equal(ended[0].params.threadId, thread.thread.id);
      assert.equal(ended[0].params.turn.id, first.turn.id);
      assert.equal(ended[0].params.turn.status, "completed");
      const history: any = await rpc.request("thread/items/list", {
        threadId: thread.thread.id,
        sortDirection: "asc",
        limit: 100,
      });
      assert.match(JSON.stringify(history), /BUSY_GUIDANCE_MARKER_7C42/);
      assert.match(JSON.stringify(history), /CONTROLLED guidance received/);
      assert.ok(JSON.stringify(history).includes(clientUserMessageId));
      await assert.rejects(() =>
        rpc.request("turn/steer", {
          threadId: thread.thread.id,
          expectedTurnId: first.turn.id,
          clientUserMessageId: randomUUID(),
          input: [
            {
              type: "text",
              text: "NOT_SENT_AFTER_COMPLETION",
              text_elements: [],
            },
          ],
        }),
      );
      assert.equal(
        requests.length,
        2,
        "An ended turn is not silently replaced",
      );
    } finally {
      releaseFirst?.();
      await rpc.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
