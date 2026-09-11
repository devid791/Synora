import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type RequestListener } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  deepSeekModels,
  deepSeekEndpoint,
  validateDeepSeekSelection,
  DeepSeekEnvelope,
  deepSeekBridge,
} from "../src/engine/deepseek-provider";
import { ResponsesToolStream } from "../src/engine/responses-tool-codec";
import { PROVIDER_TOKEN_HEADER } from "../src/engine/responses-provider";
import { configSchema, type ModelCapabilities } from "../src/shared/contracts";
const model: ModelCapabilities = {
  id: "deepseek-v4-flash",
  context_window: 1000000,
  context_window_options: [],
  reasoning_efforts: [
    "none",
    "minimal",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ],
  default_reasoning_effort: "high",
  providerModel: {
    provider: "deepseek",
    aliases: [],
    inputModalities: ["text"],
    description: "Controlled contract",
  },
};
const request = (): any => ({
  model: model.id,
  stream: true,
  store: false,
  instructions: "System",
  input: [
    { role: "developer", content: "Original workspace instructions" },
    { role: "user", content: "Read the file" },
  ],
  tools: [
    {
      type: "namespace",
      name: "functions",
      tools: [
        { type: "custom", name: "exec", description: "Executor" },
        {
          type: "function",
          name: "read_file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
            additionalProperties: false,
          },
        },
      ],
    },
  ],
  tool_choice: "auto",
  parallel_tool_calls: true,
  reasoning: { effort: "high" },
  include: ["reasoning.encrypted_content"],
  client_metadata: { session_id: "session-original" },
  session_id: "session-original",
  prompt_cache_key: "prefix-original",
});
function prepare(source = request(), selected = model) {
  const e = new DeepSeekEnvelope(selected);
  return {
    e,
    source,
    wire: JSON.parse(e.request(Buffer.from(JSON.stringify(source))).toString()),
  };
}
async function convert(e: DeepSeekEnvelope, frames: any[]) {
  const bytes = Buffer.from(
    frames
      .map((f) => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`)
      .join(""),
  );
  const chunks: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += 7)
    chunks.push(bytes.subarray(i, i + 7));
  let output = "";
  await pipeline(
    Readable.from(chunks),
    new ResponsesToolStream(e.tools),
    async (s) => {
      for await (const c of s) output += c;
    },
  );
  return output
    .split("\n\n")
    .filter((x) => x.includes("data:"))
    .map((x) =>
      JSON.parse(
        x
          .split("\n")
          .find((x) => x.startsWith("data:"))!
          .slice(5),
      ),
    );
}
async function server(t: any, handler: RequestListener) {
  const s = createServer(handler);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  t.after(
    () =>
      new Promise<void>((r) => {
        s.closeAllConnections();
        s.close(() => r());
      }),
  );
  return `http://127.0.0.1:${(s.address() as any).port}/v1`;
}
test("DeepSeek authenticated identities, dated capability metadata, unknown models and configuration", async (t) => {
  const config = {
    id: "ds",
    name: "DeepSeek",
    kind: "provider",
    providerType: "deepseek",
    endpoint: "https://api.deepseek.com",
    auth: "api-key",
    tools: [],
    enabled: true,
  };
  assert.equal(configSchema.parse(config).providerType, "deepseek");
  for (const patch of [
    { auth: "none" },
    { auth: "oauth" },
    { tools: ["invented"] },
  ])
    assert.equal(
      configSchema.safeParse({ ...config, ...patch }).success,
      false,
    );
  for (const u of [
    "http://api.deepseek.com",
    "https://evil.invalid/v1",
    "https://api.deepseek.com:444/v1",
    "https://u:p@api.deepseek.com",
    "https://api.deepseek.com/v1?key=secret",
  ])
    assert.throws(() => deepSeekEndpoint(u));
  let duplicate = false;
  const endpoint = await server(t, (req: any, res: any) => {
    assert.equal(req.headers.authorization, "Bearer fixture");
    assert.equal(req.url, "/v1/models");
    res.end(
      JSON.stringify({
        object: "list",
        data: [
          "deepseek-v4-flash",
          duplicate ? "deepseek-v4-flash" : "future-model",
        ].map((id) => ({ id, object: "model", owned_by: "deepseek" })),
      }),
    );
  });
  await assert.rejects(() => deepSeekModels(endpoint), /key/);
  const models = await deepSeekModels(endpoint, "fixture");
  assert.equal(models[0].context_window, 1000000);
  assert.equal(models[1].context_window, null);
  assert.ok(models[1].unavailableReason);
  assert.equal(validateDeepSeekSelection(models, model.id, "max").id, model.id);
  assert.throws(() => validateDeepSeekSelection(models, "future-model"));
  assert.throws(() =>
    validateDeepSeekSelection(models, model.id, "ultra-fast"),
  );
  duplicate = true;
  await assert.rejects(() => deepSeekModels(endpoint, "fixture"), /duplicate/);
});
test("DeepSeek native envelope retains identities, catalog, instructions and all seven official efforts", () => {
  for (const effort of model.reasoning_efforts) {
    const source = request();
    source.reasoning.effort = effort;
    const before = JSON.stringify(source);
    source.input.push({
      type: "reasoning",
      id: "r1",
      summary: [],
      encrypted_content: null,
      content: [{ type: "reasoning_text", text: "Original reasoning" }],
    });
    source.input.push(
      {
        type: "custom_tool_call",
        name: "exec",
        namespace: "functions",
        id: "i1",
        call_id: "c1",
        input: "text(1)",
      },
      { type: "custom_tool_call_output", call_id: "c1", output: "1" },
    );
    const snapshot = JSON.stringify(source),
      { e, wire } = prepare(source);
    assert.equal(JSON.stringify(source), snapshot);
    assert.ok(before);
    assert.equal(wire.input[0].role, "system");
    assert.equal(wire.input[0].content, "Original workspace instructions");
    assert.equal(wire.input[2].content[0].text, "Original reasoning");
    assert.equal(wire.input[3].call_id, "c1");
    assert.equal(wire.input[3].id, "i1");
    assert.equal(wire.input[4].output, "1");
    assert.deepEqual(JSON.parse(wire.input[3].arguments), { input: "text(1)" });
    assert.equal(wire.reasoning.effort, effort);
    assert.equal(wire.tools.length, 2);
    assert.deepEqual(e.tools.counts, {
      advertised: 2,
      translated: 2,
      rejected: 0,
    });
    assert.ok(
      e.metadata.some(
        (x) => x.path === "$.session_id" && x.value === "session-original",
      ),
    );
    assert.ok(!("include" in wire));
    assert.ok(!("prompt_cache_key" in wire));
  }
});
test("DeepSeek explicit incompatibility instead of silent upstream feature loss", () => {
  const mutations: [string, (s: any) => void][] = [
    ["parallel", (s) => (s.parallel_tool_calls = false)],
    ["previous", (s) => (s.previous_response_id = "remote")],
    ["background", (s) => (s.background = true)],
    ["summary", (s) => (s.reasoning.summary = "auto")],
    ["temperature", (s) => (s.temperature = 0.7)],
    ["verbosity", (s) => (s.text = { verbosity: "high" })],
    ["future", (s) => (s.future_parameter = true)],
    [
      "opaque",
      (s) =>
        s.input.push({
          type: "reasoning",
          encrypted_content: "opaque",
          summary: [],
        }),
    ],
    [
      "image",
      (s) =>
        (s.input[1].content = [
          { type: "input_image", image_url: "https://example.org/a.png" },
        ]),
    ],
    [
      "file",
      (s) => (s.input[1].content = [{ type: "input_file", file_id: "file1" }]),
    ],
    [
      "compaction",
      (s) => s.input.push({ type: "compaction", encrypted_content: "opaque" }),
    ],
    [
      "missing-result",
      (s) =>
        s.input.push({
          type: "function_call",
          name: "x",
          call_id: "c",
          arguments: "{}",
        }),
    ],
    ["hosted", (s) => s.tools.push({ type: "computer_use" })],
  ];
  for (const [label, mutate] of mutations) {
    const source = request();
    mutate(source);
    assert.throws(() => prepare(source), label);
  }
});
test("DeepSeek vision model preserves image input and tool result bytes, no local URL fetch", () => {
  const selected = {
    ...model,
    id: "deepseek-v4-flash-vision-exp",
    providerModel: {
      ...model.providerModel!,
      inputModalities: ["text", "image"],
    },
  };
  const source = request();
  source.model = selected.id;
  const image = {
    type: "input_image",
    image_url: "data:image/png;base64,aGk=",
    detail: "low",
  };
  source.input[1].content = [image];
  const { wire } = prepare(source, selected);
  assert.deepEqual(wire.input[1].content, [image]);
});
test("DeepSeek fragmented SSE, plain reasoning defaults and parallel original custom/function identities", async () => {
  const { e, wire } = prepare();
  const calls = [
    {
      type: "function_call",
      id: "item-a",
      call_id: "call-a",
      name: wire.tools[0].name,
      arguments: JSON.stringify({ input: 'text("héllo")' }),
    },
    {
      type: "function_call",
      id: "item-b",
      call_id: "call-b",
      name: wire.tools[1].name,
      arguments: '{"path":"a.txt"}',
    },
  ];
  const reasoning = {
    type: "reasoning",
    id: "reason-1",
    content: [{ type: "reasoning_text", text: "Original provider reasoning." }],
  };
  const frames: any[] = [
    { type: "response.created", response: { id: "r", status: "in_progress" } },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...reasoning, content: [] },
    },
    {
      type: "response.reasoning_text.delta",
      item_id: reasoning.id,
      output_index: 0,
      content_index: 0,
      delta: reasoning.content[0].text,
    },
    { type: "response.output_item.done", output_index: 0, item: reasoning },
  ];
  for (const [i, c] of calls.entries())
    frames.push({
      type: "response.output_item.added",
      output_index: i + 1,
      item: { ...c, arguments: "" },
    });
  for (const [i, c] of calls.entries())
    for (let j = 0; j < c.arguments.length; j += 3)
      frames.push({
        type: "response.function_call_arguments.delta",
        item_id: c.id,
        output_index: i + 1,
        delta: c.arguments.slice(j, j + 3),
      });
  for (const [i, c] of calls.entries())
    frames.push(
      {
        type: "response.function_call_arguments.done",
        item_id: c.id,
        output_index: i + 1,
        arguments: c.arguments,
      },
      { type: "response.output_item.done", output_index: i + 1, item: c },
    );
  frames.push({
    type: "response.completed",
    response: { id: "r", status: "completed", output: [reasoning, ...calls] },
  });
  const events = await convert(e, frames),
    output = events.at(-1).response.output;
  assert.deepEqual(output[0].summary, []);
  assert.equal(output[0].content[0].text, reasoning.content[0].text);
  assert.equal(output[1].type, "custom_tool_call");
  assert.equal(output[1].namespace, "functions");
  assert.equal(output[1].input, 'text("héllo")');
  assert.equal(output[1].call_id, "call-a");
  assert.equal(output[2].name, "read_file");
  assert.equal(output[2].arguments, calls[1].arguments);
  assert.equal(output[2].call_id, "call-b");
  assert.equal(
    events
      .filter((x) => x.type === "response.custom_tool_call_input.delta")
      .map((x) => x.delta)
      .join(""),
    'text("héllo")',
  );
});
test("DeepSeek cannot complete with malformed arguments, unknown tools or a truncated stream", async () => {
  for (const bad of ["schema", "json", "name", "truncated"]) {
    const { e, wire } = prepare();
    const c = {
      type: "function_call",
      id: "i",
      call_id: "c",
      name: bad === "name" ? "invented" : wire.tools[1].name,
      arguments: "",
    };
    const frames: any[] = [
      {
        type: "response.created",
        response: { id: "r", status: "in_progress" },
      },
    ];
    if (bad !== "truncated")
      frames.push(
        { type: "response.output_item.added", output_index: 0, item: c },
        {
          type: "response.output_item.done",
          output_index: 0,
          item: { ...c, arguments: bad === "json" ? "bad" : '{"path":123}' },
        },
      );
    await assert.rejects(() => convert(e, frames), { name: /Error/ }, bad);
  }
});
test("DeepSeek private bridge preserves upstream status, redacts credentials and closes on deadline", async (t) => {
  let mode = "error",
    closed = false;
  const endpoint = await server(t, (req: any, res: any) => {
    assert.equal(req.headers.authorization, "Bearer private-fixture-key");
    if (mode === "error") {
      res.writeHead(429);
      res.end("private-fixture-key quota");
    } else {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(
        'event: response.created\ndata: {"type":"response.created","response":{"id":"r","status":"in_progress"}}\n\n',
      );
      res.on("close", () => (closed = true));
    }
  });
  const b = await deepSeekBridge({
    endpoint,
    token: "private-fixture-key",
    model,
    deadlineMs: 100,
  });
  t.after(() => b.close());
  const send = () =>
    fetch(`${b.endpoint}/responses`, {
      method: "POST",
      headers: { [PROVIDER_TOKEN_HEADER]: b.token },
      body: JSON.stringify(request()),
    });
  const denied = await fetch(`${b.endpoint}/responses`, {
    method: "POST",
    body: "{}",
  });
  assert.equal(denied.status, 403);
  const error = await send();
  assert.equal(error.status, 429);
  const text = await error.text();
  assert.match(text, /REDACTED/);
  assert.ok(!text.includes("private-fixture-key"));
  mode = "hold";
  const held = await send();
  await assert.rejects(() => held.text());
  for (let i = 0; i < 40 && !closed; i++)
    await new Promise((r) => setTimeout(r, 5));
  assert.equal(closed, true);
});
