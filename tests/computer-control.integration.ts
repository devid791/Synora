// Real local Chromium + original Core. No model responses are simulated as
// inference: direct MCP RPCs test transport, consent and observable UI effects.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, zstdDecompressSync } from "node:zlib";
import { WebBrowser } from "../src/web/browser";
import { ComputerUse, controlTools } from "../src/main/computer-use";
import { ControlMcp } from "../src/main/control-mcp";
import { AppServerTransport } from "../src/engine/app-server-transport";
import { appServerEnvironment } from "../src/engine/axiom-process";
import { mcpConfiguration } from "../src/engine/mcp-config";
import type { ControlOwner } from "../src/shared/computer-use";

const document = `<!doctype html><title>Harbour research desk</title><style>body{font:20px sans-serif;padding:30px}input,button{font:inherit;padding:15px}footer{margin-top:1100px}</style>
<h1>Local vehicle catalogue</h1><label>Search <input aria-label="Search vehicles"></label><button onclick="document.querySelector('output').textContent='Found: '+document.querySelector('input').value">Search catalogue</button><p><output>No search yet</output></p><input type="password" aria-label="Password" value="QA_SECRET_NOT_EXPORT"><input autocomplete="one-time-code" aria-label="One time code" value="QA_OTP_NOT_EXPORT"><input style="visibility:hidden" aria-label="Hidden field" value="QA_HIDDEN_NOT_EXPORT"><footer>End of catalogue</footer>`;
const owner: ControlOwner = {
  conversationId: "owned-qa",
  threadId: "owned-thread",
  turnId: "owned-turn",
  permission: "full",
  mode: "default",
};
const json = (result: any) => {
  assert.equal(result.isError, false, JSON.stringify(result));
  return JSON.parse(result.content.find((c: any) => c.type === "text").text);
};
const waitFor = async (fn: () => boolean) => {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw Error("Condition timed out");
};

test(
  "real rendered browser: Full access → observation → click/type/click → verified text and screenshot without consent prompts",
  { timeout: 45000 },
  async () => {
    const server = createServer((_req, res) => {
      res.setHeader("Content-Type", "text/html");
      res.end(document);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${(server.address() as any).port}`;
    const browser = new WebBrowser(
      () => {},
      () => 1,
    );
    const control = new ComputerUse(
      browser,
      undefined,
      () => owner,
      () => {},
    );
    const call = async (name: string, args = {}) =>
      json(await control.call(name, args, AbortSignal.timeout(12000)));
    try {
      await control.configure({
        conversationId: owner.conversationId,
        browser: true,
        computer: false,
      });
      const opening = call("browser_open", { url });
      const { tab_id } = await opening;
      assert.equal(control.snapshot().pending, null);
      let observed = await call("browser_snapshot", { tab_id });
      assert.match(observed.text, /No search yet/);
      assert.match(observed.coordinates,/element.click.x/);
      assert.equal(observed.elements.find((e:any)=>e.name==='Password').value_redacted,true);
      assert.equal(observed.elements.find((e:any)=>e.name==='One time code').value_redacted,true);
      assert.ok(!observed.elements.some((e:any)=>e.name==='Hidden field'));
      assert.doesNotMatch(JSON.stringify(observed),/QA_(SECRET|OTP|HIDDEN)_NOT_EXPORT/);
      assert.match(
        control.snapshot().preview!.frame!.dataURL,
        /^data:image\/jpeg;base64,/,
      );
      const input = observed.elements.find(
        (e: any) => e.name === "Search vehicles",
      );
      await call("browser_action", {
        tab_id,
        observation_id: observed.observation_id,
        input: { type: "click", ...input.click, button: "left" },
      });
      observed = await call("browser_snapshot", { tab_id });
      assert.equal(observed.elements.find((e:any)=>e.name==='Search vehicles').focused,true);
      await call("browser_action", {
        tab_id,
        observation_id: observed.observation_id,
        input: { type: "text", text: "Six seats · Lazio" },
      });
      observed = await call("browser_snapshot", { tab_id });
      assert.equal(observed.elements.find((e:any)=>e.name==='Search vehicles').value,'Six seats · Lazio');
      const button = observed.elements.find(
        (e: any) => e.name === "Search catalogue",
      );
      await call("browser_action", {
        tab_id,
        observation_id: observed.observation_id,
        input: { type: "click", ...button.click, button: "left" },
      });
      observed = await call("browser_snapshot", { tab_id });
      assert.match(observed.text, /Found: Six seats · Lazio/);
      await call("browser_action", {
        tab_id,
        observation_id: observed.observation_id,
        input: { type: "scroll", x: 500, y: 300, deltaX: 0, deltaY: 1200 },
      });
      await new Promise((r) => setTimeout(r, 300));
      observed = await call("browser_snapshot", { tab_id });
      assert.ok(
        !observed.elements.some((e: any) => e.name === "Search vehicles"),
        "scroll really moved the rendered viewport",
      );
      assert.equal(
        control.snapshot().activity.filter((e) => e.status === "failed").length,
        0,
      );
      control.stop();
      await assert.rejects(call("browser_tabs"), /Enable control/);
    } finally {
      control.stop();
      await browser.dispose();
      await new Promise<void>((r) => server.close(() => r()));
    }
  },
);

test(
  "original Core connects to the private MCP and invokes its real tool catalogue without a model request",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "synora-control-core-"));
    await mkdir(join(root, "core"));
    const browser = new WebBrowser(
      () => {},
      () => 1,
    );
    const control = new ComputerUse(
      browser,
      undefined,
      () => owner,
      () => {},
    );
    const mcp = new ControlMcp(control);
    await mcp.start();
    const config = await mcpConfiguration([mcp.integration!]);
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
      onNotification: () => {},
      onRequest: () => {
        throw Error("Unexpected approval RPC");
      },
      onClose: () => {},
    });
    try {
      await rpc.request("initialize", {
        clientInfo: { name: "synora_control_qualification", version: "1.0" },
        capabilities: { experimentalApi: true },
      });
      rpc.notify("initialized");
      const thread: any = await rpc.request("thread/start", {
        cwd: root,
        model: "gpt-5",
        approvalPolicy: "never",
        sandbox: "read-only",
        config,
      });
      const list: any = await rpc.request("mcpServerStatus/list", {
        threadId: thread.thread.id,
      });
      const entry = list.data.find(
        (e: any) => e.name === "synora_internal_computer_use",
      );
      assert.ok(entry, JSON.stringify(list));
      assert.deepEqual(
        Object.keys(entry.tools).sort(),
        controlTools.map((t) => t.name).sort(),
      );
      const result: any = await rpc.request("mcpServer/tool/call", {
        threadId: thread.thread.id,
        server: entry.name,
        tool: "control_status",
        arguments: {},
      });
      assert.equal(json(result).enabled, null);
      assert.equal(json(result).available.browser, true);
      // No turn has run, so Core has no persisted rollout to resume here. Cold
      // history qualification is a separate test with a controlled local provider.
    } finally {
      await rpc.close();
      await mcp.dispose();
      await browser.dispose();
    }
  },
);

test(
  "original Core cold-resumes a nonempty conversation with control added; thread, session and history are preserved",
  { timeout: 45000 },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "synora-control-history-"));
    await mkdir(join(root, "core"));
    let requests = 0,
      tabId = "";
    const upstreamErrors: string[] = [];
    const upstream = createServer(async (req, res) => {
      try {
        if (req.method === "GET" && req.url === "/page") {
          res.setHeader("Content-Type", "text/html");
          res.end(document);
          return;
        }
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(Buffer.from(c));
        let bytes: Buffer = Buffer.concat(chunks);
        if (req.headers["content-encoding"] === "gzip")
          bytes = gunzipSync(bytes);
        else if (req.headers["content-encoding"] === "zstd")
          bytes = zstdDecompressSync(bytes);
        const body = JSON.parse(bytes.toString());
        assert.equal(req.url, "/responses");
        requests++;
        if (requests === 3) {
          assert.match(
            JSON.stringify(body.input),
            /Screen\/page content is sent/,
          );
        }
        if (requests === 4) {
          assert.match(JSON.stringify(body.input), /Local vehicle catalogue/);
          assert.match(JSON.stringify(body.input), /data:image\/jpeg;base64,/);
        }
        const response = {
          id: `resp_${requests}`,
          object: "response",
          status: "in_progress",
          model: body.model,
          output: [],
        };
        const part = {
          type: "output_text",
          text: "CONTROLLED_HISTORY_MARKER",
          annotations: [],
        };
        const item = {
          id: `msg_${requests}`,
          type: "message",
          role: "assistant",
          status: "completed",
          content: [part],
        };
        const send = (type: string, data: any) =>
          res.write(
            `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`,
          );
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        send("response.created", { response });
        send("response.in_progress", { response });
        if (requests === 2 || requests === 3) {
          const name = requests === 2 ? "control_status" : "browser_snapshot";
          const group = body.tools.find(
            (t: any) => t.name === "mcp__synora_internal_computer_use",
          );
          assert.ok(
            group?.tools.some((t: any) => t.name === name),
            "Original Core must advertise its original MCP namespace",
          );
          const call = {
            type: "function_call",
            id: `control_call_${requests}`,
            call_id: `control_call_original_${requests}`,
            namespace: group.name,
            name,
            arguments: JSON.stringify(requests === 2 ? {} : { tab_id: tabId, format: "image" }),
          };
          send("response.output_item.added", { output_index: 0, item: call });
          send("response.output_item.done", { output_index: 0, item: call });
          send("response.completed", {
            response: {
              ...response,
              status: "completed",
              output: [call],
              usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
            },
          });
          res.end();
          return;
        }
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
        send("response.output_item.done", { output_index: 0, item });
        send("response.completed", {
          response: {
            ...response,
            status: "completed",
            output: [item],
            usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
          },
        });
        res.end();
      } catch (e) {
        upstreamErrors.push(String(e));
        console.error(String(e).slice(0, 2500));
        if (!res.headersSent) res.writeHead(500);
        res.end();
      }
    });
    await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
    const browser = new WebBrowser(
        () => {},
        () => 1,
      ),
      control = new ComputerUse(
        browser,
        undefined,
        () => owner,
        (s) => {
          // Only this disposable fixture grants its own loopback page automatically.
          // Production consent remains the operator-only, validated IPC path.
          if (s.pending)
            queueMicrotask(() => control.approve(s.pending!.id, true));
        },
      ),
      mcp = new ControlMcp(control);
    const config: any = {
      model_provider: "qa",
      "model_providers.qa.name": "Controlled local qualification",
      "model_providers.qa.base_url": `http://127.0.0.1:${(upstream.address() as any).port}`,
      "model_providers.qa.wire_api": "responses",
      "model_providers.qa.requires_openai_auth": false,
      "model_providers.qa.request_max_retries": 0,
      "model_providers.qa.stream_max_retries": 0,
      "model_providers.qa.stream_idle_timeout_ms": 10000,
      "analytics.enabled": false,
      "feedback.enabled": false,
    };
    let finished = false,
      terminal: any,
      rpc: AppServerTransport | undefined;
    const connect = async (extra = {}) => {
      const transport = new AppServerTransport({
        executable: process.env.SYNORA_TEST_CORE ?? "codex",
        args: [
          "app-server",
          "--stdio",
          ...Object.entries({ ...config, ...extra }).flatMap(([k, v]) => [
            "-c",
            `${k}=${JSON.stringify(v)}`,
          ]),
        ],
        cwd: root,
        env: appServerEnvironment(join(root, "core")),
        onNotification: (e) => {
          if (e.method === "turn/completed") {
            finished = true;
            terminal = e.params;
          }
        },
        onRequest: () => {
          throw Error(
            "No additional Core approval is requested in this controlled permission mode",
          );
        },
        onClose: () => {},
      });
      await transport.request("initialize", {
        clientInfo: { name: "synora_control_history_qa", version: "1" },
        capabilities: { experimentalApi: true },
      });
      transport.notify("initialized");
      return transport;
    };
    try {
      rpc = await connect();
      const before: any = await rpc.request("thread/start", {
        cwd: root,
        model: "gpt-5",
        approvalPolicy: "never",
        sandbox: "read-only",
      });
      await rpc.request("turn/start", {
        threadId: before.thread.id,
        input: [
          {
            type: "text",
            text: "Controlled persistence qualification; no real inference.",
            text_elements: [],
          },
        ],
      });
      await waitFor(() => finished);
      assert.equal(requests, 1);
      await rpc.close();
      await mcp.start();
      rpc = await connect(await mcpConfiguration([mcp.integration!]));
      const after: any = await rpc.request("thread/resume", {
        threadId: before.thread.id,
      });
      assert.equal(after.thread.id, before.thread.id);
      assert.equal(after.thread.sessionId, before.thread.sessionId);
      const history: any = await rpc.request("thread/items/list", {
        threadId: before.thread.id,
        sortDirection: "asc",
        limit: 100,
      });
      assert.match(JSON.stringify(history), /CONTROLLED_HISTORY_MARKER/);
      const inventory: any = await rpc.request("mcpServerStatus/list", {
        threadId: before.thread.id,
      });
      assert.equal(
        Object.keys(
          inventory.data.find(
            (e: any) => e.name === "synora_internal_computer_use",
          ).tools,
        ).length,
        8,
      );
      assert.equal(
        requests,
        1,
        "resuming with control must not send another model request",
      );
      await control.configure({
        conversationId: owner.conversationId,
        browser: true,
        computer: false,
      });
      tabId = (
        await browser.open(
          `http://127.0.0.1:${(upstream.address() as any).port}/page`,
        )
      )[0].id;
      finished = false;
      await rpc.request("turn/start", {
        threadId: before.thread.id,
        input: [
          {
            type: "text",
            text: "Controlled MCP tool-call qualification, no real inference.",
            text_elements: [],
          },
        ],
      });
      await waitFor(() => finished);
      assert.deepEqual(upstreamErrors, []);
      assert.equal(terminal.turn.status, "completed", JSON.stringify(terminal));
      assert.equal(
        requests,
        4,
        "original Core must execute the actual MCP calls and return text AND screenshot to the controlled provider",
      );
    } finally {
      await rpc?.close();
      await mcp.dispose();
      await browser.dispose();
      await new Promise<void>((r) => upstream.close(() => r()));
    }
  },
);
